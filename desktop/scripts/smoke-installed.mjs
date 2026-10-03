// Exercise the installed bundle with no source checkout or system Node in PATH.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const app = resolve(process.argv[2]),
  state = mkdtempSync("/tmp/aar-installed-");
writeFileSync(
  join(state, "config.json"),
  JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }),
  { mode: 0o600 },
);
const resources = join(app, "Contents/Resources/resources");
const env = {
  ...process.env,
  AAR_STATE_DIR: state,
  PATH: "/usr/bin:/bin",
  NODE_OPTIONS: "",
  NODE_PATH: "",
};
const request = (operation, body = {}) =>
  JSON.parse(
    execFileSync(
      join(resources, "node"),
      [join(resources, "core/cli.js"), "--state", state, "owner-request", operation],
      {
        env,
        input: JSON.stringify(body),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 25000,
      },
    ),
  );
let child;
try {
  child = spawn(join(app, "Contents/MacOS/agent-auth-router-desktop"), ["--background"], {
    env,
    stdio: "ignore",
  });
  let first;
  for (let i = 0; i < 100; i++) {
    try {
      first = request("overview");
      break;
    } catch {}
    await delay(100);
  }
  assert.ok(first, "installed shell must start its bundled core");
  assert.match(first.node, /^v24\.19\.0$/);
  assert.equal(first.build.version, "0.1.0");
  request("accounts/add", { id: "work", provider: "codex" });
  assert.equal(request("overview").accounts[0].id, "work");
  child.kill("SIGTERM");
  await once(child, "exit");
  child = undefined;
  assert.equal(request("overview").routerId, first.routerId, "app exit retains the core");
  child = spawn(join(app, "Contents/MacOS/agent-auth-router-desktop"), ["--background"], {
    env,
    stdio: "ignore",
  });
  await delay(750);
  assert.equal(
    request("overview").routerId,
    first.routerId,
    "second shell attaches to the existing core",
  );
  request("stop", { routerId: first.routerId });
  for (let i = 0; i < 100 && existsSync(join(state, "control.sock")); i++) await delay(50);
  assert.equal(
    existsSync(join(state, "control.sock")),
    false,
    "explicit stop releases private IPC",
  );
  console.log(
    JSON.stringify(
      {
        appVersion: first.build.version,
        node: first.node,
        source: first.build.source,
        coreSha256: first.build.coreSha256,
        enrollment: true,
        retainedRouterOnAppExit: true,
        attach: true,
        stop: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  try {
    const current = request("overview");
    request("stop", { routerId: current.routerId });
  } catch {}
  await delay(100);
  rmSync(state, { recursive: true, force: true });
}
