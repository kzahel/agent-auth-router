import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir, waitFor } from "./support.ts";

test("printed login commands preserve literal profile paths and Claude clears auth/storage overrides", { skip: process.platform === "win32" }, () => {
  const state = tempDir();
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const bin = join(state, "bin"); mkdirSync(bin);
  const script = '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2),home:process.argv[1].endsWith("/claude")?process.env.CLAUDE_CONFIG_DIR:process.env.CODEX_HOME,base:process.env.ANTHROPIC_BASE_URL,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,storage:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,cloud:process.env.CLAUDE_CODE_USE_BEDROCK}));\n';
  for (const provider of ["claude", "codex"] as const) {
    writeFileSync(join(bin, provider), script, { mode: 0o700 });
    const home = join(state, `${provider}-'$(touch injection-marker)`);
    execFileSync(process.execPath, ["src/cli.ts", "--state", state, "account", "add", provider, "--provider", provider, "--home", home, "--helper", "none"], { cwd: process.cwd(), stdio: "pipe" });
    const printed = execFileSync(process.execPath, ["src/cli.ts", "--state", state, "account", "login-command", provider], { cwd: process.cwd(), encoding: "utf8" });
    const observed = JSON.parse(execFileSync("/bin/sh", ["-c", printed], {
      cwd: state,
      env: { ...process.env, CODEX_HOME: "synthetic-other", CLAUDE_CONFIG_DIR: "synthetic-other", PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_BASE_URL: "http://synthetic.invalid", CLAUDE_CODE_OAUTH_TOKEN: "SECRET-SYNTHETIC", CLAUDE_SECURESTORAGE_CONFIG_DIR: "synthetic-other", CLAUDE_CODE_USE_BEDROCK: "1" },
      encoding: "utf8",
    }));
    assert.equal(observed.home, home);
    assert.equal(existsSync(join(state, "injection-marker")), false);
    if (provider === "claude") {
      assert.deepEqual(observed.argv, ["auth", "login", "--claudeai"]);
      for (const key of ["base", "token", "storage", "cloud"]) assert.equal(observed[key], undefined);
    }
  }
});

test("quota CLI selects an enrolled account, reports unavailable metadata and exits nonzero", () => {
  const state = tempDir();
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  for (const id of ["one", "two"]) {
    execFileSync(process.execPath, ["src/cli.ts", "--state", state, "account", "add", id, "--provider", "claude", "--helper", "none"], { stdio: "pipe" });
  }
  const run = (args: string[]) => spawnSync(process.execPath, ["src/cli.ts", "--state", state, "account", "quotas", ...args], { encoding: "utf8" });
  const single = run(["one"]);
  assert.equal(single.status, 2);
  const snapshot = JSON.parse(single.stdout);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].accountId, "one");
  assert.equal(snapshot[0].status, "unavailable");
  assert.deepEqual(snapshot[0].windows, []);
  const all = run([]);
  assert.equal(all.status, 2);
  assert.deepEqual(JSON.parse(all.stdout).map((item: { accountId: string }) => item.accountId), ["one", "two"]);
  const unknown = run(["unknown"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /unknown account/);
});

test("repeated Ctrl-C finishes cleanup, and serve sets aside a stale socket", { skip: process.platform === "win32" }, async () => {
  const state = tempDir("acli-");
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const serve = () => {
    const child = spawn(process.execPath, ["src/cli.ts", "--state", state, "serve"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    return { child, ready: () => out.includes("Web dashboard:") };
  };
  const first = serve();
  await waitFor(first.ready, 10_000);
  // npm delivers Ctrl-C twice: once from the terminal, once forwarded.
  first.child.kill("SIGINT");
  first.child.kill("SIGINT");
  const code = await new Promise((resolve) => first.child.on("exit", resolve));
  assert.equal(code, 0);
  assert.equal(existsSync(join(state, "control.sock")), false);
  assert.equal(existsSync(join(state, "app.sock")), false);

  // A crash leaves a socket nothing answers; serve recovers instead of refusing.
  const crashed = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(join(state, "control.sock"))}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => crashed.stdout.once("data", resolve));
  crashed.kill("SIGKILL");
  await new Promise((resolve) => crashed.on("exit", resolve));
  chmodSync(join(state, "control.sock"), 0o600);
  const second = serve();
  await waitFor(second.ready, 10_000);
  assert.equal(readdirSync(state).filter((n) => n.startsWith("control.sock.stale-")).length, 1);
  second.child.kill("SIGTERM");
  await new Promise((resolve) => second.child.on("exit", resolve));
});
