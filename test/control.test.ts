import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { ControlRegistry, startControl } from "../src/control.ts";
import { authorize, generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

const ctlToken = () => "aar_ctl_" + randomBytes(32).toString("base64url");
function request(socketPath: string, path: string, token?: string, body?: object): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: body ? "POST" : "GET", headers: { host: "localhost", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, value: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

// /tmp keeps Unix socket names inside Darwin's sockaddr_un bound.
function storeFixture() {
  const store = new StateStore(tempDir("ac-")); store.init();
  const home = join(store.dir, "profiles", "fixture"); mkdirSync(home);
  writeClaudeCredentials(home, "synthetic-provider-secret", Date.now() + 3600_000);
  store.saveAccounts([{ id: "fixture", provider: "claude", home }]);
  return store;
}

test("manual bindings: lost responses, isolation, persistence and terminal revocation", { skip: process.platform === "win32" }, () => {
  const store = storeFixture();
  let registry = new ControlRegistry(store);
  const token = ctlToken(), id = randomUUID(), pair = { id, name: "test", tokenHash: hashGatewayToken(token) };
  assert.deepEqual(registry.pair(pair), registry.pair(pair));
  const integration = registry.authenticate(`Bearer ${token}`);
  const other = ctlToken(); registry.pair({ id: randomUUID(), name: "other", tokenHash: hashGatewayToken(other) });
  const gateway = generateGatewayToken();
  const allocation = { id: randomUUID(), accountId: "fixture", provider: "claude", model: "synthetic-model", tokenHash: hashGatewayToken(gateway) };
  assert.deepEqual(registry.prepare(integration, allocation), registry.prepare(integration, allocation));
  assert.equal(registry.clients().length, 0, "prepared credentials cannot infer");
  assert.throws(() => registry.prepare(integration, { ...allocation, model: "other" }), /conflicts/);
  assert.throws(() => registry.transition(registry.authenticate(`Bearer ${other}`), allocation.id, "inspect"), /not found/);
  registry.transition(integration, allocation.id, "commit");
  registry = new ControlRegistry(store);
  assert.equal(registry.clients()[0]?.tokenSha256, hashGatewayToken(gateway));
  assert.equal(registry.clients()[0]?.accounts.claude, "fixture");
  assert.throws(() => registry.authenticate(`Bearer ${gateway}`), /required/);
  const disk = readFileSync(join(store.dir, "control.json"), "utf8");
  for (const secret of [token, gateway, "synthetic-provider-secret"]) assert.equal(disk.includes(secret), false);
  const current = registry.authenticate(`Bearer ${token}`);
  registry.revoke(current);
  registry = new ControlRegistry(store);
  assert.equal(registry.clients().length, 0);
  assert.throws(() => registry.authenticate(`Bearer ${token}`), /revoked/);
  assert.throws(() => registry.pair(pair), /already used/);
});

test("private control socket routes catalogs before allocation and revokes inference", { skip: process.platform === "win32" }, async () => {
  const store = storeFixture();
  const upstream = await mockUpstream((_req, res, recorded) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(recorded.url === "/v1/models" ? { data: [{ id: "synthetic-model", display_name: "Synthetic" }] } : { ok: true }));
  });
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin } });
  const router = await startRouter(store); after(() => router.close());
  const socket = router.controlSocket!;
  const token = ctlToken();
  assert.equal((await request(socket, "/v1/accounts")).status, 401);
  const info = await request(socket, "/v1/info"); assert.equal(info.value.protocol, 1);
  assert.equal((await fetch(router.origin + "/v1/info")).status, 404);
  const pair = { id: randomUUID(), name: "YA fixture", tokenHash: hashGatewayToken(token) };
  assert.equal((await request(socket, "/v1/pair", undefined, pair)).status, 200);
  assert.equal((await request(socket, "/v1/catalog", token, { accountId: "ungranted" })).status, 403);
  const catalog = await request(socket, "/v1/catalog", token, { accountId: "fixture" });
  assert.deepEqual(catalog.value.models, [{ id: "synthetic-model", name: "Synthetic" }]);
  assert.equal(upstream.requests[0]?.headers.authorization, "Bearer synthetic-provider-secret");
  const gateway = generateGatewayToken();
  const allocation = { id: randomUUID(), accountId: "fixture", provider: "claude", model: "synthetic-model", tokenHash: hashGatewayToken(gateway) };
  assert.equal((await request(socket, "/v1/bindings/prepare", token, { ...allocation, model: "absent" })).status, 409);
  assert.equal((await request(socket, "/v1/bindings/prepare", token, allocation)).status, 200);
  const infer = (credential: string) => fetch(router.origin + "/claude/v1/messages", { method: "POST", headers: { authorization: `Bearer ${credential}` }, body: "{}" });
  assert.equal((await infer(gateway)).status, 401);
  assert.equal((await infer(token)).status, 401);
  assert.equal((await request(socket, "/v1/bindings/commit", token, { id: allocation.id })).status, 200);
  assert.equal((await infer(gateway)).status, 200);
  assert.equal((await request(socket, "/v1/disconnect", token, {})).status, 200);
  assert.equal((await infer(gateway)).status, 401);
  await router.close(); assert.equal(existsSync(socket), false);
});

test("control refuses insecure directories and occupied endpoints", { skip: process.platform === "win32" }, async () => {
  const store = storeFixture();
  chmodSync(store.dir, 0o755);
  await assert.rejects(startControl(store, "http://127.0.0.1:1", new Map()), /private/);
  chmodSync(store.dir, 0o700);
  const first = await startControl(store, "http://127.0.0.1:1", new Map()); after(() => first.close());
  await assert.rejects(startControl(store, "http://127.0.0.1:1", new Map()), /exists/);
});

test("control credentials cannot become inference credentials even if their hash is registered", () => {
  const token = ctlToken();
  assert.equal(authorize([{id: "test", name: "test", tokenSha256: hashGatewayToken(token), accounts: {claude: "fixture"}, createdAt: new Date().toISOString()}], {authorization: `Bearer ${token}`}, "claude").ok, false);
});

test("failed launches can be cancelled after their account is disabled", {skip: process.platform === "win32"}, () => {
  const store = storeFixture(), registry = new ControlRegistry(store), token = ctlToken();
  registry.pair({id: randomUUID(), name:"YA", tokenHash:hashGatewayToken(token)});
  const integration = registry.authenticate(`Bearer ${token}`), id = randomUUID();
  registry.prepare(integration, {id, accountId:"fixture", provider:"claude", model:"synthetic", tokenHash:hashGatewayToken(generateGatewayToken())});
  registry.transition(integration, id, "commit");
  store.saveAccounts(store.loadAccounts().map(account => ({...account, enabled:false})));
  registry.transition(integration, id, "cancel");
  assert.equal(registry.binding(integration,id).state, "cancelled");
  assert.equal(registry.clients().length,0);
});
