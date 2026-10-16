import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { StateStore } from "../src/state.ts";
import { tempDir, waitFor, writeClaudeCredentials } from "./support.ts";

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

test("serve exposes public viewing only with --dashboard-public-readonly", { skip: process.platform === "win32" }, async t => {
  for (const publicReadonly of [false, true]) {
    const state = tempDir("aview-");
    writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
    const child = spawn(process.execPath, ["src/cli.ts", "--state", state, "serve", ...(publicReadonly ? ["--dashboard-public-readonly"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("exit", resolve));
    t.after(() => { child.kill("SIGTERM"); return exited; });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
    await waitFor(() => output.includes("Web dashboard:"), 10_000);
    const origin = output.match(/Web dashboard: (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
    const status = await fetch(`${origin}/auth/status`).then(r => r.json()) as { publicReadonly: boolean; authenticated: boolean; loginCommand: string };
    assert.equal(status.publicReadonly, publicReadonly);
    assert.equal(status.authenticated, false);
    assert.match(status.loginCommand, /dashboard url$/);
    const read = await fetch(`${origin}/v1/app/overview`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
    assert.equal(read.status, publicReadonly ? 200 : 401);
    child.kill("SIGTERM");
    await exited;
  }
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

function serving(state: string, command = "serve") {
  const child = spawn(process.execPath, ["src/cli.ts", "--state", state, command], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, out: () => out, exited };
}
const restartCli = (state: string, ...args: string[]) => spawnSync(process.execPath, ["src/cli.ts", "--state", state, "restart", ...args], { encoding: "utf8" });
const count = (text: string, part: string) => text.split(part).length - 1;

test("aar restart waits for an idle period, then serve starts the current code again in place", { skip: process.platform === "win32" }, async (t) => {
  const state = tempDir("arst-"), store = new StateStore(state);
  const upstream = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/event-stream" }); r.write("data: synthetic\n\n"); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` } }), { mode: 0o600 });
  const home = join(state, "profiles", "synthetic"); mkdirSync(home, { recursive: true }); writeClaudeCredentials(home, "synthetic", Date.now() + 3600_000);
  store.saveAccounts([{ id: "a", provider: "claude", home }]);
  const token = generateGatewayToken();
  store.saveClients([{ id: "c", name: "Synthetic", tokenSha256: hashGatewayToken(token), accounts: { claude: "a" }, createdAt: new Date().toISOString() }]);

  const serve = serving(state);
  t.after(() => { serve.child.kill("SIGKILL"); });
  await waitFor(() => serve.out().includes("Web dashboard:"), 10_000);
  const before = await ownerRequest(store, "overview");

  // An open stream holds the restart; the stream is never cut off.
  const response = await fetch(before.origin + "/claude/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  const reader = response.body!.getReader(); await reader.read();
  const pending = restartCli(state, "--quiet-seconds", "1");
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /restart pending: .* after 1 seconds/);
  await delay(2000);
  assert.equal(count(serve.out(), "Web dashboard:"), 1, "busy router does not restart");
  assert.doesNotMatch(serve.out(), /idle; restarting/);
  await reader.cancel();

  await waitFor(() => count(serve.out(), "Web dashboard:") === 2, 15_000);
  assert.match(serve.out(), /restart requested; waiting for 1 idle seconds[\s\S]*idle; restarting[\s\S]*starting the router again/);
  const after = await ownerRequest(store, "overview");
  assert.equal(after.routerId, before.routerId, "state and identity carry over");
  assert.equal(serve.child.exitCode, null, "the serve parent stays in place");

  // Cancel withdraws a pending request; nothing is pending afterwards.
  assert.match(restartCli(state, "--quiet-seconds", "600").stdout, /pending/);
  assert.equal(restartCli(state, "--cancel").stdout, "restart cancelled\n");
  assert.equal(restartCli(state, "--cancel").stdout, "no restart was pending\n");
  assert.match(restartCli(state, "--quiet-seconds", "0").stderr, /whole number/);
  await assert.rejects(ownerRequest(store, "restart", { routerId: after.routerId, quietSeconds: 601 }), /whole number/);
  await assert.rejects(ownerRequest(store, "restart", { routerId: "other" }), /identity/);

  serve.child.kill("SIGINT"); serve.child.kill("SIGINT");
  assert.equal(await serve.exited, 0, serve.out());
  assert.equal(existsSync(join(state, "control.sock")), false);
  assert.match(restartCli(state).stderr, /not running/);
});

test("the desktop router refuses restart, and a killed serve parent takes its router down", { skip: process.platform === "win32" }, async (t) => {
  const state = tempDir("arsd-"), store = new StateStore(state);
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const desktop = serving(state, "desktop-serve");
  t.after(() => { desktop.child.kill("SIGKILL"); });
  let overview: { routerId: string } | undefined;
  for (let i = 0; i < 200 && !overview; i++) {
    overview = await Promise.resolve().then(() => ownerRequest(store, "overview")).catch(() => undefined);
    if (!overview) await delay(50);
  }
  await assert.rejects(ownerRequest(store, "restart", { routerId: overview!.routerId }), /only under aar serve/);
  desktop.child.stdin.end(); assert.equal(await desktop.exited, 0);

  const serve = serving(state);
  await waitFor(() => serve.out().includes("Web dashboard:"), 10_000);
  serve.child.kill("SIGKILL"); await serve.exited;
  await waitFor(() => !existsSync(join(state, "control.sock")), 10_000);
});
