import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import http from "node:http";
import { diagnose, diagnosticOptions, type DiagnosticReport, type DiagnosticRuntime } from "../src/diagnostics.ts";
import { emptyObservation } from "../src/pools.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore } from "../src/state.ts";
import { tempDir, writeClaudeCredentials } from "./support.ts";

const versions = async () => [{ provider: "claude" as const, available: true, version: "1.2.3" }, { provider: "codex" as const, available: true }];
function fixture() {
  const store = new StateStore(tempDir("doctor-")); store.init();
  for (const id of ["work", "personal"]) mkdirSync(join(store.profilesDir, id), { mode: 0o700 });
  store.saveAccounts(["work", "personal"].map(id => ({ id, provider: "claude", home: join(store.profilesDir, id) })));
  return store;
}
function fingerprint(dir: string): unknown {
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name), st = lstatSync(path);
    return [name, st.mode, st.mtimeMs, st.isDirectory() ? fingerprint(path) : st.isFile() ? readFileSync(path).toString("base64") : "special"];
  });
}

test("passive diagnostics never read credentials, run provider metadata, start a router or mutate state", async () => {
  const store = fixture();
  // Reading these special paths would hang; the default must not inspect them.
  for (const account of store.loadAccounts()) mkdirSync(join(account.home, ".credentials.json"));
  const before = fingerprint(store.dir);
  const runtime: DiagnosticRuntime = {
    signIn: async () => { throw new Error("credential reader called"); },
    refresh: async () => { throw new Error("provider called"); },
    observation: () => emptyObservation(), status: () => undefined,
  };
  const report = await diagnose(store, {}, runtime, versions);
  assert.equal(report.exitCode, 0);
  assert.equal(report.findings.filter(f => f.code === "login-unchecked").length, 2);
  assert.deepEqual(fingerprint(store.dir), before);
  assert.equal(existsSync(join(store.dir, "control.sock")), false);
  const absent = new StateStore(join(store.dir, "absent"));
  assert.equal((await diagnose(absent, {}, undefined, versions)).findings[0]!.code, "state-missing");
  assert.equal(existsSync(absent.dir), false);
});

test("malformed and insecure state retains partial results without raw secrets or repairs", async () => {
  const store = fixture();
  writeFileSync(store.configPath, '{"SECRET-CONFIG":', { mode: 0o600 });
  writeFileSync(store.clientsPath, JSON.stringify({ version: 3, clients: [null] }), { mode: 0o600 });
  writeFileSync(join(store.profilesDir, "work", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://secret@example.invalid" } }));
  const before = fingerprint(store.dir), report = await diagnose(store, {}, undefined, versions);
  assert.equal(report.exitCode, 2);
  assert.ok(report.findings.some(f => f.code === "profile-endpoint-override"));
  assert.ok(report.findings.some(f => f.code === "provider-cli" && f.status === "ok"));
  assert.doesNotMatch(JSON.stringify(report), /SECRET-CONFIG|secret@example|profiles\//);
  assert.deepEqual(fingerprint(store.dir), before);
  chmodSync(store.dir, 0o755);
  assert.equal((await diagnose(store, {}, undefined, versions)).findings[0]!.code, "state-unsafe");
  assert.equal(lstatSync(store.dir).mode & 0o777, 0o755);
  chmodSync(store.dir, 0o700);
  const alias = join(tempDir("doctor-alias-"), "state"); symlinkSync(store.dir, alias);
  assert.equal((await diagnose(new StateStore(alias), {}, undefined, versions)).exitCode, 2);
});

test("explicit credential and usage checks require an account and preserve sign-in versus access evidence", async () => {
  assert.throws(() => diagnosticOptions({ checkLogin: true }));
  assert.throws(() => diagnosticOptions({ accountId: "work", refreshUsage: "yes" }));
  assert.throws(() => diagnosticOptions({ accountId: "work", repair: true }));
  const store = fixture();
  writeClaudeCredentials(join(store.profilesDir, "work"), "SECRET-ACCESS", Date.now() + 3600_000);
  const report = await diagnose(store, { accountId: "work", checkLogin: true }, undefined, versions);
  assert.ok(report.findings.some(f => f.code === "login-ready"));
  assert.ok(report.findings.every(f => f.subject !== "account:personal"));
  assert.doesNotMatch(JSON.stringify(report), /SECRET-ACCESS|SECRET-REFRESH|claudeAiOauth/);
  const expired = join(store.profilesDir, "work");
  writeClaudeCredentials(expired, "SECRET-EXPIRED", Date.now() - 1);
  assert.ok((await diagnose(store, { accountId: "work", checkLogin: true }, undefined, versions)).findings.some(f => f.code === "login-idle"));
  const refreshed: string[] = [];
  const runtime: DiagnosticRuntime = {
    signIn: async () => "renewal_failed", refresh: async a => { refreshed.push(a.id); throw new Error("SECRET-PROVIDER-ERROR"); },
    observation: () => ({ ...emptyObservation(), quota: { accountId: "work", provider: "claude", status: "ok", observedAt: new Date(Date.now() - 200_000).toISOString(), windows: [] }, error: "SECRET-ERROR" }),
    status: () => undefined,
  };
  const failed = await diagnose(store, { accountId: "work", checkLogin: true, refreshUsage: true }, runtime, versions);
  assert.deepEqual(refreshed, ["work"]);
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.findings.some(f => f.code === "quota-stale"));
  assert.ok(failed.findings.some(f => f.code === "login-renewal_failed"));
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  assert.doesNotMatch(failed.copyText, /personal|work|doctor-|profiles/);
  assert.equal((await diagnose(store, { accountId: "missing" }, undefined, versions)).exitCode, 2);
  assert.equal((await diagnose(store, { accountId: "work", refreshUsage: true }, undefined, versions)).exitCode, 1);
});

test("pool, grant and physical-profile consistency checks are passive and never expose names or hashes", async () => {
  const store = fixture(), id = "11111111-1111-4111-8111-111111111111";
  const alias = join(store.profilesDir, "alias"); symlinkSync(join(store.profilesDir, "work"), alias);
  const accounts = store.loadAccounts(); accounts[1]!.home = alias; store.saveAccounts(accounts);
  writeFileSync(join(store.dir, "control.json"), JSON.stringify({ version: 3, routerId: id, bindings: [],
    pools: [{ id, provider: "codex", accountIds: ["work"], name: "SECRET-POOL" }],
    integrations: [{ id, name: "SECRET-INTEGRATION", accountIds: [], poolIds: ["missing"], tokenHash: "SECRET-HASH" }] }), { mode: 0o600 });
  const before = fingerprint(store.dir), report = await diagnose(store, {}, undefined, versions);
  assert.ok(report.findings.some(f => f.code === "profile-shared"));
  assert.ok(report.findings.some(f => f.code === "pool-members-invalid"));
  assert.ok(report.findings.some(f => f.code === "grants-invalid"));
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  assert.deepEqual(fingerprint(store.dir), before);
});

test("doctor CLI uses isolated bounded version probes, JSON exit semantics and never bootstraps state", () => {
  const store = fixture(), bin = join(store.dir, "bin"); mkdirSync(bin);
  for (const provider of ["claude", "codex"]) writeFileSync(join(bin, provider), `#!/usr/bin/env node
if(process.argv[2]!=='--version') process.exit(9);
if(process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENAI_API_KEY || process.env.CODEX_HOME==='/SECRET') process.exit(8);
console.log('1.2.3 SECRET-OUTPUT person@example.invalid');
`, { mode: 0o700 });
  const run = (...args: string[]) => spawnSync(process.execPath, ["src/cli.ts", "--state", store.dir, "doctor", ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: "/SECRET", ANTHROPIC_AUTH_TOKEN: "SECRET", OPENAI_API_KEY: "SECRET" }, timeout: 15_000,
  });
  const result = run("--json"); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as DiagnosticReport;
  assert.equal(report.version, 1); assert.equal(report.mode, "passive");
  assert.doesNotMatch(result.stdout, /SECRET|person@/);
  assert.equal(existsSync(join(store.dir, "owner.key")), false);
  assert.equal(existsSync(join(store.dir, "control.json")), false);
  assert.equal(run("--check-login", "--json").status, 2);
  assert.equal(run("--account", "missing", "--json").status, 2);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
  const started = Date.now(), hung = run("--json");
  assert.equal(hung.status, 1); assert.ok(Date.now() - started < 7000);
  assert.ok(JSON.parse(hung.stdout).findings.some((f: { code: string; status: string }) => f.code === "provider-cli" && f.status === "error"));
});

test("running owner diagnostics are scoped and reject unauthenticated callers and invalid requests", { skip: process.platform === "win32" }, async t => {
  const store = fixture();
  writeFileSync(store.configPath, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const bin = join(store.dir, "bin"); mkdirSync(bin);
  for (const p of ["claude", "codex"]) writeFileSync(join(bin, p), "#!/bin/sh\necho 1.2.3\n", { mode: 0o700 });
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  const router = await startRouter(store, {}, { eventLog: false }); t.after(() => router.close());
  const before = fingerprint(store.profilesDir);
  const report = await ownerRequest(store, "diagnostics", { accountId: "work" }) as DiagnosticReport;
  assert.ok(report.findings.some(f => f.code === "router-running"));
  assert.deepEqual(fingerprint(store.profilesDir), before);
  await assert.rejects(ownerRequest(store, "diagnostics", { checkLogin: true }), /Choose an account/);
  const status = await new Promise<number>(resolve => {
    const req = http.request({ socketPath: join(store.dir, "control.sock"), path: "/v1/owner/diagnostics", method: "POST", headers: { host: "localhost", "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode!); });
    req.end("{}");
  });
  assert.equal(status, 401);
  // Asynchronous child avoids blocking the running owner's event loop.
  const child = spawn(process.execPath, ["src/cli.ts", "--state", store.dir, "doctor", "--json"]);
  let output = ""; child.stdout.on("data", c => { output += c; }); child.stderr.resume();
  const code = await new Promise(resolve => child.on("close", resolve));
  assert.equal(code, 0);
  assert.ok(JSON.parse(output).findings.some((f: { code: string }) => f.code === "router-running"));
});
