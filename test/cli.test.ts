import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./support.ts";

test("printed login commands preserve literal profile paths and Claude clears auth/storage overrides", { skip: process.platform === "win32" }, () => {
  const state = tempDir();
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
