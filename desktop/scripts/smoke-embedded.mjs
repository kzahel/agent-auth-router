// Debug binary built with a distinct test identifier. No real profiles or providers.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(import.meta.dirname, "..");
const state = mkdtempSync("/tmp/aar-webview-smoke-");
const node = join(root, "resources/node"), cli = join(root, "resources/core/cli.js");
const executable = resolve(process.argv[2] ?? join(root, "src-tauri/target/debug/agent-auth-router-desktop"));
writeFileSync(join(state, "synthetic-signin"), "synthetic-only", { mode: 0o600 });
writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
mkdirSync(join(state, "bin"));
writeFileSync(join(state, "fake.mjs"), `
if(!process.stdin.isTTY || !process.stdout.isTTY || !process.env.CODEX_HOME?.startsWith('/tmp/aar-webview-smoke-')) process.exit(2);
if(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) process.exit(3);
console.log('SYNTHETIC_CONFIRM'); process.stdin.once('data',()=>process.exit(0));
`);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
writeFileSync(join(state, "bin/codex"), `#!/bin/sh\nexec ${quote(node)} ${quote(join(state, "fake.mjs"))} "$@"\n`, { mode: 0o700 });
let child;
try {
  child = spawn(executable, [], { env: { ...process.env, AAR_STATE_DIR: state, AAR_SIGNIN_SMOKE: "1" }, stdio: "ignore" });
  const resultFile = join(state, "embedded-smoke.json");
  for (let i = 0; i < 400 && !existsSync(resultFile) && child.exitCode === null; i++) await delay(100);
  assert.ok(existsSync(resultFile), "Native sign-in smoke did not report a result");
  const result = JSON.parse(readFileSync(resultFile));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.window, /^signin-/);
  for (let i = 0; i < 150 && child.exitCode === null; i++) await delay(100);
  assert.equal(child.exitCode, 0, "App quit must finish");
  assert.equal(existsSync(join(state, "control.sock")), false, "App quit must stop its router");
  console.log("Native WebView sign-in passed: local assets/CSP, isolated window authority, PTY input/output and completion.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  try {
    const invoke = (op, value = {}) => JSON.parse(execFileSync(node, [cli, "--state", state, "owner-request", op], { input: JSON.stringify(value), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 25000 }));
    if (existsSync(join(state, "control.sock"))) {
      const overview = invoke("overview");
      for (const login of overview.logins.filter(l => l.status === "running")) invoke("accounts/cancel-login", { id: login.id });
      for (let i = 0; i < 30; i++) {
        try { invoke("stop", { routerId: overview.routerId }); break; } catch { await delay(150); }
      }
      for (let i = 0; i < 50 && existsSync(join(state, "control.sock")); i++) await delay(100);
      assert.equal(existsSync(join(state, "control.sock")), false, "Smoke router did not stop");
    }
  } finally { if (!existsSync(join(state, "control.sock"))) rmSync(state, { recursive: true, force: true }); }
}
