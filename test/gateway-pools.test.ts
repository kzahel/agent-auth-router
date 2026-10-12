import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { FIXTURES, mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

const fakeClaude = { claudeCommand: process.execPath, claudeArgs: [join(FIXTURES, "fake-claude-cli.ts"), "ok"] };
const MEMBERS = ["a", "b", "c"];

function send(origin: string, method: string, path: string, headers: Record<string, string>, body?: object): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const store = new StateStore(tempDir("agp-")); store.init();
  store.saveAccounts(MEMBERS.map((id) => {
    const home = join(store.dir, "profiles", id); mkdirSync(home, { recursive: true });
    writeClaudeCredentials(home, `synthetic-provider-secret-${id}`, Date.now() + 3600_000);
    return { id, provider: "claude" as const, home };
  }));
  const upstream = await mockUpstream((_req, res, recorded) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(recorded.url?.startsWith("/v1/models") ? { data: [{ id: "synthetic-model" }] } : { ok: true }));
  });
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin } });
  let router = await startRouter(store, fakeClaude);
  t.after(() => router.close());
  const poolId = randomUUID();
  await ownerRequest(store, "pools/save", { id: poolId, name: "Reviews", revision: 0, provider: "claude", policy: "weekly-pace", accountIds: MEMBERS });
  const token = generateGatewayToken();
  await ownerRequest(store, "clients/add", { record: { id: randomUUID(), name: "worker", tokenSha256: hashGatewayToken(token), createdAt: new Date().toISOString(), accounts: {}, pools: { claude: poolId } } });
  const usedAccount = () => {
    const auth = String(upstream.requests.at(-1)?.headers.authorization ?? "");
    return MEMBERS.find((id) => auth.endsWith(`synthetic-provider-secret-${id}`));
  };
  const message = async (session?: string) => {
    const result = await send(router.origin, "POST", "/claude/v1/messages", { authorization: `Bearer ${token}`, ...(session ? { "x-claude-code-session-id": session } : {}) }, { model: "synthetic-model", messages: [] });
    return { status: result.status, text: result.text, account: usedAccount() };
  };
  const restart = async () => { await router.close(); router = await startRouter(store, fakeClaude); };
  return { store, upstream, poolId, token, message, restart, origin: () => router.origin };
}

test("pool-backed gateway tokens pin each session to the policy's pick and spread new sessions", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  const a = await f.message(first);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.account, "a", "equal evidence: membership order");
  assert.equal((await f.message(first)).account, "a", "the session stays on its account");
  assert.equal((await f.message(second)).account, "b", "a fresh pin reserves its account");
  assert.equal((await f.message(third)).account, "c");
  assert.equal((await f.message(second)).account, "b");

  const pins = readFileSync(join(f.store.dir, "control.json"), "utf8");
  assert.doesNotMatch(pins, new RegExp(f.token));
  await f.restart();
  assert.equal((await f.message(first)).account, "a", "pins survive a restart");

  const models = await send(f.origin(), "GET", "/claude/v1/models", { authorization: `Bearer ${f.token}` });
  assert.equal(models.status, 200, "model listings need no session");

  const events = readdirSync(join(f.store.dir, "events")).map((name) => readFileSync(join(f.store.dir, "events", name), "utf8")).join("");
  const sessions = events.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.type === "binding" && e.action === "session");
  assert.deepEqual(sessions.map((e) => [e.sessionId, e.accountId, e.policy]), [[first, "a", "weekly-pace"], [second, "b", "weekly-pace"], [third, "c", "weekly-pace"]]);
  assert.ok(events.split("\n").filter(Boolean).some((line) => { const e = JSON.parse(line); return e.type === "request" && e.sessionId === first && e.poolId === f.poolId; }));
});

test("sessionless requests are chosen individually and never pinned", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.message()).status, 200);
  assert.equal((await f.message()).status, 200);
  const state = JSON.parse(readFileSync(join(f.store.dir, "control.json"), "utf8"));
  assert.equal(state.sessions, undefined);
});

test("a pinned session moves only when its account leaves the pool; a removed pool refuses", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const session = randomUUID();
  assert.equal((await f.message(session)).account, "a");
  await ownerRequest(f.store, "pools/save", { id: f.poolId, name: "Reviews", revision: 1, provider: "claude", policy: "weekly-pace", accountIds: ["b", "c"] });
  assert.notEqual((await f.message(session)).account, "a");
  await ownerRequest(f.store, "pools/remove", { id: f.poolId, revision: 2 });
  assert.equal((await f.message(session)).status, 403);
});

test("clients/add validates pool grants", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const record = (extra: object) => ({ record: { id: randomUUID(), name: "x", tokenSha256: hashGatewayToken(generateGatewayToken()), createdAt: new Date().toISOString(), accounts: {}, ...extra } });
  await assert.rejects(ownerRequest(f.store, "clients/add", record({ pools: { claude: randomUUID() } })), /invalid client pool/);
  await assert.rejects(ownerRequest(f.store, "clients/add", record({ pools: { codex: f.poolId } })), /invalid client pool/);
  await assert.rejects(ownerRequest(f.store, "clients/add", record({ accounts: { claude: "a" }, pools: { claude: f.poolId } })), /invalid client pool/);
  await assert.rejects(ownerRequest(f.store, "clients/add", record({})), /invalid client/);
});
