// Real WKWebView confirmation and updater IPC, with synthetic update results.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const state = mkdtempSync("/tmp/aar-update-");
const app = resolve(import.meta.dirname, "../src-tauri/target/debug/agent-auth-router-desktop");
let child;
try {
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }));
  writeFileSync(join(state, "synthetic-signin"), "synthetic-only");
  child = spawn(app, [], { env: { ...process.env, AAR_STATE_DIR: state, AAR_LIFECYCLE_SMOKE: "1", AAR_UPDATE_SMOKE: "1" }, stdio: "ignore" });
  for (let i = 0; i < 250 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  assert.equal(child.exitCode, 0, "Native update dialog must confirm and expose failure");
  assert.equal(JSON.parse(readFileSync(join(state, "embedded-smoke.json"))).ok, true);
  assert.equal(readFileSync(join(state, "update-invoked"), "utf8"), "0.1.999");
  assert.equal(existsSync(join(state, "control.sock")), false);
  console.log("Native update confirmation: cancel, accept, real IPC and visible failure passed.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  for (let i = 0; i < 150 && existsSync(join(state, "control.sock")); i++) await delay(100);
  if (!existsSync(join(state, "control.sock"))) rmSync(state, { recursive: true, force: true });
}
