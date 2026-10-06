import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ownerRequest } from "../src/owner.ts";
import { clientSessionId, EventLog, eventLogEnabled } from "../src/events.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { captureLogs, FIXTURES, mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

const readEvents = (dir: string) => readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort()
  .flatMap(n => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>));

describe("event log", () => {
  test("writes one JSON line per event into a private UTC day file", () => {
    const dir = join(tempDir(), "events");
    let now = Date.UTC(2026, 9, 6, 23, 59, 59);
    const log = new EventLog({ dir, now: () => now });
    log.write("router", { action: "start" });
    assert.equal(existsSync(log.fileFor(now)), false, "lines are buffered");
    log.flush();
    now += 2000;
    log.write("quota", { accountId: "a" });
    log.close();
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["2026-10-06.jsonl", "2026-10-07.jsonl"]);
    for (const file of files) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const events = readEvents(dir);
    assert.deepEqual(events.map(e => [e.v, e.type, e.at]), [[1, "router", "2026-10-06T23:59:59.000Z"], [1, "quota", "2026-10-07T00:00:01.000Z"]]);
    assert.equal(events[1]!.accountId, "a");
  });

  test("prunes day files past retention and refuses a symlinked day file", () => {
    const lines = captureLogs();
    const dir = join(tempDir(), "events");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.UTC(2026, 9, 6);
    writeFileSync(join(dir, "2026-07-01.jsonl"), "{}\n", { mode: 0o600 });
    writeFileSync(join(dir, "2026-07-10.jsonl"), "{}\n", { mode: 0o600 });
    writeFileSync(join(dir, "notes.txt"), "keep", { mode: 0o600 });
    const log = new EventLog({ dir, now: () => now });
    assert.deepEqual(readdirSync(dir).sort(), ["2026-07-10.jsonl", "notes.txt"], "files older than 90 days go; others stay");
    const target = join(dir, "elsewhere.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, log.fileFor(now));
    log.write("router", { action: "start" });
    log.close();
    assert.equal(readFileSync(target, "utf8"), "", "nothing follows the symlink");
    assert.ok(lines.some(l => l.includes("events.insecure_file")));
    log.write("router", { action: "again" });
    log.flush();
    assert.equal(readFileSync(target, "utf8"), "", "the log stays disabled");
  });

  test("a bounded buffer drops the oldest lines and reports the count once", () => {
    const lines = captureLogs();
    const dir = join(tempDir(), "events");
    const log = new EventLog({ dir, now: () => Date.UTC(2026, 9, 6) });
    for (let i = 0; i < 5_010; i++) log.write("request", { i });
    log.close();
    const events = readEvents(dir);
    assert.equal(events.length, 5_000);
    assert.equal(events[0]!.i, 10);
    assert.ok(lines.some(l => l.includes("events.dropped") && l.includes("10")));
  });

  test("AAR_EVENT_LOG switches the log off only for explicit falsy values", () => {
    assert.equal(eventLogEnabled({}), true);
    assert.equal(eventLogEnabled({ AAR_EVENT_LOG: "1" }), true);
    for (const value of ["0", "false", "OFF", " no "]) assert.equal(eventLogEnabled({ AAR_EVENT_LOG: value }), false, value);
  });

  test("client session ids come from the Codex header or Claude Code's metadata, never the body", () => {
    assert.equal(clientSessionId("codex", { session_id: "019a5c4e-6d2b-7f40-9f0e-3c5a2b1d9e77" }, Buffer.alloc(0)), "019a5c4e-6d2b-7f40-9f0e-3c5a2b1d9e77");
    assert.equal(clientSessionId("codex", { session_id: "bad value" }, Buffer.alloc(0)), undefined);
    assert.equal(clientSessionId("codex", {}, Buffer.from('{"metadata":{"user_id":"x"}}')), undefined);
    const session = randomUUID(), account = randomUUID();
    const body = Buffer.from(JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "SECRET PROMPT" }], metadata: { user_id: `user_${"ab".repeat(32)}_account_${account}_session_${session}` } }));
    assert.equal(clientSessionId("claude", { session_id: "ignored" }, body), session);
    assert.equal(clientSessionId("claude", {}, Buffer.from('{"metadata":{"user_id":"user_short_session_x"}}')), undefined);
    assert.equal(clientSessionId("claude", {}, Buffer.from("{}")), undefined);
  });
});

const fakeClaude = { claudeCommand: process.execPath, claudeArgs: [join(FIXTURES, "fake-claude-cli.ts"), "ok"] };
function control(socketPath: string, path: string, token: string, body: object): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}` } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, value: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

test("the router records bindings, requests, quota observations and rejections end to end", { skip: process.platform === "win32" }, async t => {
  const store = new StateStore(tempDir("ev-")); store.init();
  const home = join(store.profilesDir, "fixture"); mkdirSync(home);
  writeClaudeCredentials(home, "synthetic-provider-secret", Date.now() + 3600_000);
  store.saveAccounts([{ id: "fixture", provider: "claude", home }]);
  let status = 200;
  const upstream = await mockUpstream((_req, res, recorded) => {
    if (recorded.url === "/v1/models") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] })); }
    res.writeHead(status, { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-5h-reset": "1790000000", ...(status === 429 ? { "retry-after": "30" } : {}) });
    res.end(JSON.stringify({ type: "message", model: "synthetic-model", usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin } });
  const router = await startRouter(store, fakeClaude); t.after(() => router.close());
  assert.ok(router.events, "on by default");
  const socket = router.controlSocket!, ctl = "aar_ctl_" + "a".repeat(43), integrationId = randomUUID(), poolId = randomUUID();
  await control(socket, "/v1/pair", ctl, { id: integrationId, name: "YA", tokenHash: hashGatewayToken(ctl) });
  await ownerRequest(store, "pools/save", { id: poolId, name: "Work", revision: 0, provider: "claude", policy: "most-remaining", accountIds: ["fixture"] });
  await ownerRequest(store, "grants/save", { id: integrationId, revision: 1, poolIds: [poolId] });
  const gateway = generateGatewayToken();
  const allocation = { id: randomUUID(), poolId, model: "synthetic-model", provider: "claude", tokenHash: hashGatewayToken(gateway), supportedPolicies: ["most-remaining"] };
  assert.equal((await control(socket, "/v1/pools/prepare", ctl, { ...allocation, model: "absent" })).status, 409);
  assert.equal((await control(socket, "/v1/pools/prepare", ctl, allocation)).status, 200);
  assert.equal((await control(socket, "/v1/pools/prepare", ctl, allocation)).status, 200, "replays are not re-recorded");
  assert.equal((await control(socket, "/v1/bindings/commit", ctl, { id: allocation.id })).status, 200);
  const session = randomUUID();
  const infer = () => fetch(router.origin + "/claude/v1/messages", { method: "POST", headers: { authorization: `Bearer ${gateway}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "synthetic-model", messages: [{ role: "user", content: "SECRET PROMPT" }], metadata: { user_id: `user_${"cd".repeat(32)}_account_${randomUUID()}_session_${session}` } }) });
  assert.equal((await infer()).status, 200);
  status = 429;
  assert.equal((await infer()).status, 429);
  assert.equal((await control(socket, "/v1/bindings/cancel", ctl, { id: allocation.id })).status, 200);
  assert.equal((await control(socket, "/v1/bindings/cancel", ctl, { id: randomUUID() })).status, 200);
  await router.close();

  const dir = join(store.dir, "events");
  const events = readEvents(dir);
  const text = readdirSync(dir).map(n => readFileSync(join(dir, n), "utf8")).join("");
  assert.doesNotMatch(text, /SECRET|tokenHash|synthetic-provider-secret|profiles|aar_ctl_|"request":/);
  assert.deepEqual(events.map(e => e.type + (e.action ? ":" + e.action : "") + (e.source ? ":" + e.source : "")),
    ["router:start", "quota:probe", "binding:refuse", "binding:prepare", "binding:commit", "quota:inference", "request", "rejection", "request", "binding:cancel", "binding:cancel", "router:stop"]);
  const [start, probe, refuse, prepare, commit, observed, ok, rejection, failed, cancel, unprepared, stop] = events as Record<string, any>[];
  assert.equal(start!.routerId, stop!.routerId);
  assert.equal(probe!.accountId, "fixture"); assert.ok(probe!.windows.length > 1, "the probe reports every bucket");
  assert.equal(refuse!.candidates[0].eligibility, "model-unavailable"); assert.equal(refuse!.bindingId, allocation.id);
  assert.equal(prepare!.policy, "most-remaining"); assert.equal(prepare!.accountId, "fixture");
  assert.deepEqual(prepare!.candidates.map((c: any) => [c.accountId, c.eligibility, c.rank, c.headroomPercent]), [["fixture", "eligible", 0, 55]]);
  assert.equal(commit!.previousState, "prepared"); assert.equal(commit!.state, "committed");
  assert.equal(ok!.bindingId, allocation.id); assert.equal(ok!.sessionId, session); assert.equal(ok!.poolId, poolId);
  assert.equal(ok!.outcome, "ok"); assert.equal(ok!.usage.output, 5); assert.equal(ok!.model, "synthetic-model");
  assert.equal(observed!.requestId, ok!.requestId, "header quota joins its request");
  assert.deepEqual(observed!.windows.map((w: any) => [w.bucket, w.remainingPercent, w.resetsAt]), [["five_hour", 75, new Date(1_790_000_000_000).toISOString()]]);
  assert.equal(rejection!.status, 429); assert.equal(rejection!.retryAfter, "30"); assert.equal(rejection!.requestId, failed!.requestId);
  assert.equal(failed!.outcome, "error");
  assert.equal(cancel!.accountId, "fixture"); assert.equal(unprepared!.unprepared, true);
});

test("--no-event-log and AAR_EVENT_LOG=0 keep the state directory free of events", { skip: process.platform === "win32" }, async t => {
  const store = new StateStore(tempDir("ev-off-")); store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const router = await startRouter(store, {}, { eventLog: false }); t.after(() => router.close());
  assert.equal(router.events, undefined);
  await router.close();
  assert.equal(existsSync(join(store.dir, "events")), false);
});
