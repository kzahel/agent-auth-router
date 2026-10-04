// Prove external pairing reaches an already-rendered native UI without Reload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const state = mkdtempSync("/tmp/aar-pairing-");
const app = resolve(import.meta.dirname, "../src-tauri/target/debug/agent-auth-router-desktop");
let child;
try {
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }));
  writeFileSync(join(state, "synthetic-signin"), "synthetic-only");
  mkdirSync(join(state, "bin"));
  child = spawn(app, [], { env: { ...process.env, AAR_STATE_DIR: state, AAR_LIFECYCLE_SMOKE: "1", AAR_PAIRING_SMOKE: "1" }, stdio: "ignore" });
  for (let i = 0; i < 150 && !existsSync(join(state, "pairing-ready")) && child.exitCode === null; i++) await delay(100);
  assert.ok(existsSync(join(state, "pairing-ready")), "Initial empty connection list must render");
  const token = `aar_ctl_${Buffer.alloc(32, 7).toString("base64url")}`;
  await new Promise((resolve, reject) => {
    const req = request({ socketPath: join(state, "control.sock"), path: "/v1/pair", method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}` } }, res => {
      res.resume();
      res.on("end", () => res.statusCode === 200 ? resolve() : reject(Error(`Pairing failed: ${res.statusCode}`)));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(Error("Pairing timed out")));
    req.end(JSON.stringify({ id: randomUUID(), name: "Synthetic YA", tokenHash: createHash("sha256").update(token).digest("hex") }));
  });
  for (let i = 0; i < 150 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  assert.equal(child.exitCode, 0, "Native UI must observe pairing and finish Quit");
  assert.equal(JSON.parse(readFileSync(join(state, "embedded-smoke.json"))).ok, true);
  assert.equal(existsSync(join(state, "control.sock")), false);
  console.log("External pairing appeared automatically in the native UI; observation did not restart a stopped router.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  for (let i = 0; i < 150 && existsSync(join(state, "control.sock")); i++) await delay(100);
  if (!existsSync(join(state, "control.sock"))) rmSync(state, { recursive: true, force: true });
}
