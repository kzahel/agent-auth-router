import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { acknowledgeCrashes, CRASH_EXIT_CODE, crashFromError, crashFromExit, crashesPath, readCrashes, recordCrash, summarize, unacknowledgedCrashes } from "../src/crash.ts";
import { installLogFile, LogFile, logFiles, logsDir } from "../src/log-file.ts";
import { log, setLogSink } from "../src/log.ts";
import { CRASH_LIMIT, READY_MESSAGE, RESTART_EXIT_CODE, restartDelayMs, Supervisor } from "../src/supervisor.ts";
import { tempDir } from "./support.ts";

describe("crash records", () => {
  test("an error becomes a sanitized record with bounded frames and the home directory as ~", () => {
    const error = Object.assign(new Error("Cannot pipe with Bearer sk-ant-abcdefghijklmnopqrstuvwxyz"), { code: "ERR_STREAM_UNABLE_TO_PIPE" });
    error.stack = `Error: ignored\n${Array.from({ length: 20 }, (_, i) => `    at frame${i} (file://${homedir()}/router/src/server.ts:${i}:1)`).join("\n")}`;
    const record = crashFromError(error, "uncaughtException", () => Date.UTC(2026, 9, 25, 15, 18, 24));
    assert.equal(record.kind, "exception");
    assert.equal(record.at, "2026-10-25T15:18:24.000Z");
    assert.equal(record.code, "ERR_STREAM_UNABLE_TO_PIPE");
    assert.doesNotMatch(record.message, /sk-ant/);
    assert.equal(record.stack!.length, 12);
    assert.equal(record.stack![0], "at frame0 (~/router/src/server.ts:0:1)");
    assert.ok(!JSON.stringify(record).includes(homedir()));
    assert.deepEqual(summarize(record), { id: record.id, at: record.at, kind: "exception", code: "ERR_STREAM_UNABLE_TO_PIPE", message: record.message, frame: record.stack![0] });
  });

  test("a thrown non-error is recorded by its text", () => {
    assert.equal(crashFromError("plain", "unhandledRejection").message, "plain");
  });

  test("acknowledging a crash hides it and every earlier one, not a later one", () => {
    const state = tempDir();
    let time = Date.UTC(2026, 9, 25);
    const next = () => (time += 1000);
    const first = crashFromExit(null, "SIGKILL", 1, next), second = crashFromExit(1, null, 2, next), third = crashFromExit(1, null, 3, next);
    for (const crash of [first, second, third]) recordCrash(state, crash);
    assert.equal(first.message, "router stopped by SIGKILL");
    assert.equal(second.message, "router exited with status 1");
    assert.equal(statSync(crashesPath(state)).mode & 0o777, 0o600);
    assert.equal(acknowledgeCrashes(state, second.id), true);
    assert.deepEqual(unacknowledgedCrashes(state).map(crash => crash.id), [third.id]);
    assert.equal(acknowledgeCrashes(state, first.id), true, "an older id keeps the later acknowledgement");
    assert.deepEqual(unacknowledgedCrashes(state).map(crash => crash.id), [third.id]);
    assert.equal(acknowledgeCrashes(state, "unknown"), false);
    assert.equal(readCrashes(state).length, 3);
  });

  test("the file keeps the latest 50 records", () => {
    const state = tempDir();
    for (let i = 0; i < 55; i++) recordCrash(state, crashFromExit(i, null, i));
    const kept = readCrashes(state);
    assert.equal(kept.length, 50);
    assert.equal(kept[0]!.exitCode, 5);
  });

  test("an unreadable file reads as no crashes", () => {
    const state = tempDir();
    writeFileSync(crashesPath(state), "{", { mode: 0o600 });
    assert.deepEqual(readCrashes(state), []);
  });

  for (const [origin, source] of [
    ["uncaughtException", "setTimeout(() => { throw Object.assign(new Error('boom'), { code: 'ERR_SYNTHETIC' }); }, 0);"],
    ["unhandledRejection", "Promise.reject(new Error('rejected'));"],
  ] as const) {
    test(`an ${origin} records the crash, logs it and exits with the crash status`, () => {
      const state = tempDir();
      const script = `import { installCrashHandler } from ${JSON.stringify(join(import.meta.dirname, "../src/crash.ts"))};
        import { installLogFile } from ${JSON.stringify(join(import.meta.dirname, "../src/log-file.ts"))};
        installLogFile(${JSON.stringify(state)});
        let flushed = false;
        installCrashHandler(${JSON.stringify(state)}, () => { flushed = true; process.stdout.write("flushed"); });
        ${source}`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(result.status, CRASH_EXIT_CODE, result.stderr);
      assert.equal(result.stdout, "flushed");
      assert.match(result.stderr, /aar: router crashed/);
      const [crash] = readCrashes(state);
      assert.equal(crash!.kind, "exception");
      assert.equal(crash!.origin, origin);
      assert.match(crash!.message, origin === "uncaughtException" ? /Error: boom/ : /Error: rejected/);
      const logged = readFileSync(join(logsDir(state), logFiles(logsDir(state))[0]!), "utf8");
      assert.match(logged, /"event":"router.crash"/);
    });
  }
});

describe("log file", () => {
  test("lines go to a private file per UTC day, and days past retention are removed", () => {
    const dir = join(tempDir(), "logs");
    let time = Date.UTC(2026, 9, 1, 23, 59);
    const file = new LogFile({ dir, now: () => time, retentionDays: 7 });
    file.write("first");
    time += 2 * 60_000;
    file.write("second");
    assert.deepEqual(logFiles(dir), ["router-2026-10-01.log", "router-2026-10-02.log"]);
    assert.equal(readFileSync(join(dir, "router-2026-10-02.log"), "utf8"), "second\n");
    assert.equal(statSync(join(dir, "router-2026-10-02.log")).mode & 0o777, 0o600);
    time = Date.UTC(2026, 9, 8, 12);
    file.write("later");
    assert.deepEqual(logFiles(dir), ["router-2026-10-02.log", "router-2026-10-08.log"]);
    file.close();
  });

  test("the file sink keeps the previous sink, and AAR_LOG_FILE=0 turns it off", (t) => {
    const lines: string[] = [];
    const original = setLogSink(line => lines.push(line));
    t.after(() => setLogSink(original));
    const state = tempDir();
    assert.equal(installLogFile(state, { AAR_LOG_FILE: "0" }), undefined);
    const file = installLogFile(state, {})!;
    t.after(() => file.close());
    log("synthetic.event", { n: 1 });
    assert.equal(lines.length, 1);
    assert.match(readFileSync(join(logsDir(state), logFiles(logsDir(state))[0]!), "utf8"), /"event":"synthetic.event","n":1/);
  });

  test("a log file that cannot be written is reported once and stderr logging continues", (t) => {
    const lines: string[] = [];
    const original = setLogSink(line => lines.push(line));
    t.after(() => setLogSink(original));
    const state = tempDir();
    writeFileSync(logsDir(state), "not a directory");
    installLogFile(state, {});
    log("one"); log("two");
    assert.equal(lines.filter(line => line.includes("log_file.failed")).length, 1);
    assert.equal(lines.filter(line => /"event":"(one|two)"/.test(line)).length, 2);
  });
});

class FakeChild extends EventEmitter {
  pid: number;
  killed: string[] = [];
  constructor(pid: number) { super(); this.pid = pid; }
  kill(signal: string) { this.killed.push(signal); return true; }
}

function supervised(state: string, now: () => number = Date.now) {
  const children: FakeChild[] = [], waits: number[] = [], output: string[] = [];
  const supervisor = new Supervisor({
    stateDir: state, now,
    spawn: () => { const child = new FakeChild(100 + children.length); children.push(child); return child as unknown as ChildProcess; },
    write: text => output.push(text),
    sleep: async ms => { waits.push(ms); },
  });
  const spawned = async (count: number) => { while (children.length < count) await new Promise(resolve => setImmediate(resolve)); return children[count - 1]!; };
  return { supervisor, children, waits, output, spawned };
}

describe("serve supervisor", () => {
  test("restart delays double from one second", () => {
    assert.deepEqual([1, 2, 3, 4].map(restartDelayMs), [1000, 2000, 4000, 8000]);
  });

  test("a crash after startup is recorded and the router starts again; a later clean exit ends serve", async () => {
    const state = tempDir();
    const h = supervised(state);
    const done = h.supervisor.run();
    const first = await h.spawned(1);
    first.emit("message", READY_MESSAGE);
    first.emit("exit", null, "SIGKILL");
    const second = await h.spawned(2);
    assert.deepEqual(h.waits, [1000]);
    assert.match(h.output.join(""), /crashed; starting it again in 1s/);
    const [crash] = readCrashes(state);
    assert.equal(crash!.kind, "exit");
    assert.equal(crash!.signal, "SIGKILL");
    assert.equal(crash!.pid, 100);

    second.emit("message", READY_MESSAGE);
    second.emit("exit", CRASH_EXIT_CODE, null);
    const third = await h.spawned(3);
    assert.equal(readCrashes(state).length, 1, "a router that recorded its own crash is not recorded twice");
    assert.deepEqual(h.waits, [1000, 2000]);

    third.emit("message", READY_MESSAGE);
    third.emit("exit", 0, null);
    assert.equal(await done, 0);
  });

  test("a router that exits before it is serving is not started again", async () => {
    const state = tempDir();
    const h = supervised(state);
    const done = h.supervisor.run();
    (await h.spawned(1)).emit("exit", 1, null);
    assert.equal(await done, 1);
    assert.equal(h.children.length, 1);
    assert.equal(existsSync(crashesPath(state)), false);
  });

  test("an aar restart starts the router again without counting a crash", async () => {
    const h = supervised(tempDir());
    const done = h.supervisor.run();
    const first = await h.spawned(1);
    first.emit("message", READY_MESSAGE);
    first.emit("exit", RESTART_EXIT_CODE, null);
    const second = await h.spawned(2);
    assert.deepEqual(h.waits, []);
    assert.match(h.output.join(""), /starting the router again/);
    h.supervisor.stop("SIGINT");
    assert.deepEqual(second.killed, ["SIGINT"]);
    second.emit("exit", 0, null);
    assert.equal(await done, 0);
  });

  test(`${CRASH_LIMIT} crashes within five minutes stop restarting; older crashes fall out of the window`, async () => {
    const state = tempDir();
    let time = 0;
    const h = supervised(state, () => time);
    const done = h.supervisor.run();
    const crash = async (n: number) => {
      const child = await h.spawned(n);
      child.emit("message", READY_MESSAGE); child.emit("exit", 1, null);
      await new Promise(resolve => setImmediate(resolve));
    };
    await crash(1);
    time += 10 * 60_000;
    for (let n = 2; n <= CRASH_LIMIT + 1; n++) { await crash(n); time += 1000; }
    assert.equal(await done, 1);
    assert.equal(h.children.length, CRASH_LIMIT + 1);
    assert.deepEqual(h.waits, [1000, 1000, 2000, 4000, 8000]);
    assert.match(h.output.at(-1)!, new RegExp(`crashed ${CRASH_LIMIT} times within 5 minutes; not starting it again`));
    assert.equal(readCrashes(state).length, CRASH_LIMIT + 1);
  });

  test("a signal during the restart wait stops serve without starting the router", async () => {
    const children: FakeChild[] = [];
    const supervisor = new Supervisor({
      stateDir: tempDir(), write: () => {},
      spawn: () => { const child = new FakeChild(1); children.push(child); return child as unknown as ChildProcess; },
      sleep: async () => { supervisor.stop("SIGTERM"); },
    });
    const done = supervisor.run();
    while (!children.length) await new Promise(resolve => setImmediate(resolve));
    children[0]!.emit("message", READY_MESSAGE);
    children[0]!.emit("exit", 1, null);
    assert.equal(await done, 0);
    assert.equal(children.length, 1);
  });
});
