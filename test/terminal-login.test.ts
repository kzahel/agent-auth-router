import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore } from "../src/state.ts";
import { loginArgs } from "../src/terminal-login.ts";
import { tempDir } from "./support.ts";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for terminal fixture");
}

test("terminal authentication has a TTY, isolated profile, method choices and cancellation", async t => {
  assert.deepEqual(loginArgs("codex", "1"), ["login"]);
  assert.deepEqual(loginArgs("claude", "2"), ["auth", "login", "--claudeai", "--sso"]);
  assert.throws(() => loginArgs("codex", "--with-api-key"), /Choose/);
  const store = new StateStore(tempDir("terminal-"));
  store.init(); writeFileSync(join(store.dir, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const bin = join(store.dir, "bin"); mkdirSync(bin);
  const fake = join(bin, "fake.mjs");
  writeFileSync(fake, `import {writeFileSync, existsSync} from 'node:fs';
const home=process.env.CODEX_HOME??process.env.CLAUDE_CONFIG_DIR;
writeFileSync(home+'/probe.json', JSON.stringify({pid:process.pid, parent:process.ppid, tty:!!process.stdin.isTTY && !!process.stdout.isTTY, home, args:process.argv.slice(2), gateway:process.env.ANTHROPIC_AUTH_TOKEN??null, api:process.env.OPENAI_API_KEY??null, base:process.env.ANTHROPIC_BASE_URL??null}));
console.log('fixture official login output');
if(!existsSync(home+'/hold')) { console.log('fixture asks for confirmation'); process.stdin.once('data', () => process.exit(0)); }
if(existsSync(home+'/hold')) setInterval(()=>{},1000);
`);
  for (const provider of ["codex", "claude"]) {
    const path = join(bin, provider);
    writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); chmodSync(path, 0o700);
  }
  const router = await startRouter(store); t.after(() => router.close());
  async function launch(id: string, provider: "codex" | "claude", hold = false) {
    await ownerRequest(store, "accounts/add", { id, provider });
    const home = join(store.profilesDir, id);
    if (hold) writeFileSync(join(home, "hold"), "");
    const runner = spawn("python3", ["-c", "import pty,sys,os; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))", process.execPath, resolve("src/cli.ts"), "--state", store.dir, "terminal-login", id], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_AUTH_TOKEN: "forbidden", OPENAI_API_KEY: "forbidden", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = ""; runner.stdout.on("data", chunk => { output += chunk; });
    runner.stderr.resume();
    const done = new Promise<number | null>(r => runner.once("close", r));
    t.after(() => { runner.kill("SIGTERM"); });
    await until(() => output.includes("Choose [1/2]"));
    await assert.rejects(router.coordinators.get(id)!.credential(), /login in progress/);
    const overview = await ownerRequest(store, "overview");
    assert.doesNotMatch(JSON.stringify(overview), /terminal-begin|forbidden|runnerPid/);
    await assert.rejects(ownerRequest(store, "accounts/login", { id }), /already running/);
    await assert.rejects(ownerRequest(store, "stop", { routerId: overview.routerId }), /busy/);
    return { runner, done, home, output: () => output };
  }
  for (const provider of ["codex", "claude"] as const) {
    const id = `login-${provider}`, f = await launch(id, provider);
    f.runner.stdin.write(provider === "codex" ? "2\n" : "1\n");
    await until(() => f.output().includes("fixture asks for confirmation"));
    f.runner.stdin.write("yes\n");
    assert.equal(await f.done, 0, f.output());
    const probe = JSON.parse(readFileSync(join(f.home, "probe.json"), "utf8"));
    assert.deepEqual({ ...probe, pid: 0, parent: 0 }, { pid: 0, parent: 0, tty: true, home: f.home, args: provider === "codex" ? ["login", "--device-auth"] : ["auth", "login", "--claudeai"], gateway: null, api: null, base: null });
    assert.equal((await ownerRequest(store, "accounts/login-status", { id })).loginStatus, "complete");
  }
  const hold = await launch("cancel", "claude", true);
  hold.runner.stdin.write("1\n");
  await until(() => existsSync(join(hold.home, "probe.json")));
  const pid = JSON.parse(readFileSync(join(hold.home, "probe.json"), "utf8")).pid;
  await ownerRequest(store, "accounts/cancel-login", { id: "cancel" });
  await hold.done;
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal((await ownerRequest(store, "accounts/login-status", { id: "cancel" })).loginStatus, "cancelled");
  const closed = await launch("closed", "claude", true);
  closed.runner.stdin.write("1\n");
  await until(() => existsSync(join(closed.home, "probe.json")));
  const closedProbe = JSON.parse(readFileSync(join(closed.home, "probe.json"), "utf8"));
  process.kill(closedProbe.parent, "SIGHUP");
  await closed.done;
  await until(() => { try { process.kill(closedProbe.pid, 0); return false; } catch { return true; } });
  const prompt = await launch("prompt", "codex");
  await ownerRequest(store, "accounts/cancel-login", { id: "prompt" });
  await prompt.done;
  assert.equal(existsSync(join(prompt.home, "probe.json")), false);
});
