import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ControlRegistry, normalizePairingCode } from "../src/control.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { clientAddress, parsePublicOrigin } from "../src/public.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { mockUpstream, tempDir, uiBuild, writeClaudeCredentials } from "./support.ts";

const skip = process.platform === "win32";
const HOST = "aar.example.com";
const ORIGIN = `https://${HOST}`;
const ctlToken = () => "aar_ctl_" + randomBytes(32).toString("base64url");

interface Reply { status: number; headers: http.IncomingHttpHeaders; text: string; value: any }
/** A request to the public listener as the TLS proxy forwards it. */
function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: object | string } = {}): Promise<Reply> {
  const body = typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? (body ? "POST" : "GET"), headers: { host: HOST, ...(body ? { "content-type": "application/json" } : {}), ...options.headers } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => { let value; try { value = JSON.parse(text); } catch { value = undefined; } resolve({ status: res.statusCode!, headers: res.headers, text, value }); });
    });
    req.on("error", reject); req.end(body);
  });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Sends a raw WebSocket upgrade and returns the response status line. */
function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(["GET /v1/app/ws HTTP/1.1", ...Object.entries({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers }).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));
    });
    let data = "";
    socket.on("data", chunk => { data += chunk; if (data.includes("\r\n")) { socket.destroy(); resolve(data.split("\r\n")[0]!); } });
    socket.on("error", reject);
  });
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const upstream = await mockUpstream((_req, res, recorded) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(recorded.url === "/v1/models" ? { data: [{ id: "synthetic-model", display_name: "Synthetic" }] } : { ok: true }));
  });
  const store = new StateStore(tempDir("ap-")); store.init();
  const home = join(store.profilesDir, "work"); mkdirSync(home);
  writeClaudeCredentials(home, "synthetic-provider-secret", Date.now() + 3600_000);
  store.saveAccounts([{ id: "work", provider: "claude", home, helper: { kind: "none" } }]);
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin } });
  const router = await startRouter(store, {}, { dashboard: { port: 0, uiDir: uiBuild() }, public: { origin: ORIGIN, port: 0 } });
  t.after(() => router.close(true));
  return { store, router, upstream, port: router.public!.port };
}

test("public origins must be bare https origins; forwarded addresses use the proxy's entry", () => {
  assert.equal(parsePublicOrigin("https://aar.example.com").origin, ORIGIN);
  assert.equal(parsePublicOrigin("https://aar.example.com:8443/").origin, "https://aar.example.com:8443");
  for (const bad of ["http://aar.example.com", "https://aar.example.com/x", "https://u:p@aar.example.com", "https://aar.example.com/?q", "aar.example.com"])
    assert.throws(() => parsePublicOrigin(bad), /public origin/, bad);
  const req = (forwarded?: string) => ({ headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress: "127.0.0.1" } }) as unknown as http.IncomingMessage;
  assert.equal(clientAddress(req()), "127.0.0.1");
  assert.equal(clientAddress(req("198.51.100.1, 203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(req("not-an-address")), "127.0.0.1");
  assert.equal(normalizePairingCode("4f7q k9m2"), "4F7QK9M2");
  assert.equal(normalizePairingCode("4F7Q-K9M0"), undefined, "0 is not in the alphabet");
  assert.equal(normalizePairingCode("short"), undefined);
});

test("public listener: exact host, integration control only, and no owner administration", { skip }, async t => {
  const { router, port, store } = await fixture(t);
  assert.equal((await send(port, "/control/v1/info", { headers: { host: "evil.example" } })).status, 421);
  assert.equal((await send(port, "/claude/v1/models", { headers: { host: "127.0.0.1" } })).status, 421);
  assert.match(await upgrade(port, { host: "evil.example", origin: ORIGIN }), / 421 /);
  const info = await send(port, "/control/v1/info");
  assert.equal(info.status, 200);
  assert.equal(info.value.inferenceOrigin, ORIGIN);
  assert.ok(info.value.capabilities.includes("remote-pairing-v1"));
  assert.equal(info.value.routerId, (await ownerRequest(store, "overview", {})).routerId);
  // The socket keeps reporting loopback and no remote pairing.
  const local = await new Promise<any>((resolve, reject) => {
    http.get({ socketPath: router.controlSocket!, path: "/v1/info", headers: { host: "localhost" } }, res => { let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve(JSON.parse(text))); }).on("error", reject);
  });
  assert.equal(local.inferenceOrigin, router.origin);
  assert.equal(local.capabilities.includes("remote-pairing-v1"), false);
  const ownerKey = readFileSync(join(store.dir, "owner.key"), "utf8");
  assert.equal((await send(port, "/control/v1/owner/overview", { headers: bearer(ownerKey), body: {} })).status, 404);
  assert.equal((await send(port, "/control/v1/info", { headers: { origin: ORIGIN } })).status, 403, "browsers cannot call control");
  assert.equal((await send(port, "/control/v1/accounts")).status, 401);
  // Inference without a gateway token is refused in the provider's shape.
  assert.equal((await send(port, "/claude/v1/messages", { body: {} })).status, 401);
});

test("device pairing: pending until the owner types the code, then full control and inference over HTTPS paths", { skip }, async t => {
  const { port, store, upstream } = await fixture(t);
  const poolId = randomUUID();
  await ownerRequest(store, "pools/save", { id: poolId, revision: 0, name: "Work", provider: "claude", policy: "manual", accountIds: ["work"] });
  const token = ctlToken(), id = randomUUID();
  const request = { id, name: "Laptop YA", tokenHash: hashGatewayToken(token) };
  const pending = await send(port, "/control/v1/pair", { body: request, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(pending.status, 200);
  assert.equal(pending.value.state, "pending");
  assert.match(pending.value.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(pending.value.verificationUri, `${ORIGIN}/#pair`);
  assert.equal(JSON.stringify(pending.value).includes(token), false);
  // Repeating returns the same code; another secret for the same identity is refused.
  assert.equal((await send(port, "/control/v1/pair", { body: request })).value.userCode, pending.value.userCode);
  assert.equal((await send(port, "/control/v1/pair", { body: { ...request, tokenHash: hashGatewayToken(ctlToken()) } })).status, 409);

  const waiting = await send(port, "/control/v1/accounts", { headers: bearer(token) });
  assert.equal(waiting.status, 403);
  assert.equal(waiting.value.code, "pairing_pending");
  assert.equal(waiting.value.userCode, pending.value.userCode);
  assert.equal((await send(port, "/control/v1/pair/status", { headers: bearer(token) })).value.code, "pairing_pending");

  // The owner sees the request but not its code, and cannot approve a wrong code.
  const { pairings } = await ownerRequest(store, "pairings/list", {});
  assert.deepEqual(pairings.map((p: any) => [p.id, p.name, p.address]), [[id, "Laptop YA", "203.0.113.9"]]);
  assert.equal(JSON.stringify(pairings).includes(pending.value.userCode.replace("-", "")), false);
  assert.equal(JSON.stringify(await ownerRequest(store, "overview", {})).includes(pending.value.userCode), false);
  await assert.rejects(ownerRequest(store, "pairings/approve", { userCode: "2222-2222", poolIds: [poolId] }), /No pending pairing/);
  await assert.rejects(ownerRequest(store, "pairings/approve", { userCode: pending.value.userCode, poolIds: [randomUUID()] }), /invalid pool grants/);
  assert.equal((await ownerRequest(store, "pairings/list", {})).pairings.length, 1, "a refused approval leaves the request waiting");
  await ownerRequest(store, "pairings/approve", { userCode: pending.value.userCode.toLowerCase(), poolIds: [poolId] });
  assert.equal((await ownerRequest(store, "pairings/list", {})).pairings.length, 0);
  assert.deepEqual((await ownerRequest(store, "overview", {})).integrations.map((i: any) => [i.id, i.name, i.poolIds]), [[id, "Laptop YA", [poolId]]]);

  assert.equal((await send(port, "/control/v1/pair/status", { headers: bearer(token) })).value.state, "active");
  assert.equal((await send(port, "/control/v1/pair", { body: request })).value.state, "active");
  const accounts = await send(port, "/control/v1/accounts", { headers: bearer(token) });
  assert.deepEqual(accounts.value.accounts.map((a: any) => a.id), ["work"]);
  const catalog = await send(port, "/control/v1/catalog", { headers: bearer(token), body: { accountId: "work" } });
  assert.deepEqual(catalog.value.models.map((m: any) => m.id), ["synthetic-model"]);

  const gateway = generateGatewayToken(), binding = randomUUID();
  const prepared = await send(port, "/control/v1/pools/prepare", { headers: bearer(token), body: { id: binding, poolId, accountId: "work", provider: "claude", model: "synthetic-model", tokenHash: hashGatewayToken(gateway) } });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal((await send(port, "/control/v1/bindings/commit", { headers: bearer(token), body: { id: binding } })).status, 200);
  const infer = (credential: string) => send(port, "/claude/v1/messages", { headers: bearer(credential), body: {} });
  assert.equal((await infer(gateway)).status, 200);
  assert.equal(upstream.requests.at(-1)?.headers.authorization, "Bearer synthetic-provider-secret");
  assert.equal((await infer(token)).status, 401, "control credentials never infer");
  // Revocation from the owner reaches the public paths.
  await ownerRequest(store, "integrations/revoke", { id });
  assert.equal((await infer(gateway)).status, 401);
  assert.equal((await send(port, "/control/v1/accounts", { headers: bearer(token) })).status, 401);
  assert.equal((await send(port, "/control/v1/pair", { body: request })).status, 409);
});

test("pairing requests expire, are capped, rate limited and can be denied", { skip }, async t => {
  const { port, store } = await fixture(t);
  const pair = (address: string, token = ctlToken()) => send(port, "/control/v1/pair", { body: { id: randomUUID(), name: "device", tokenHash: hashGatewayToken(token) }, headers: { "x-forwarded-for": address } });
  for (let i = 0; i < 4; i++) assert.equal((await pair("198.51.100.7")).status, 200);
  const capped = await pair("198.51.100.7");
  assert.equal(capped.status, 429, "per-address pending cap");
  assert.match(capped.value.error, /too many pending/);
  const denied = (await ownerRequest(store, "pairings/list", {})).pairings[0];
  await ownerRequest(store, "pairings/deny", { id: denied.id });
  assert.equal((await ownerRequest(store, "pairings/list", {})).pairings.length, 3);
  for (let i = 0; i < 5; i++) await pair("198.51.100.7");
  const limited = await pair("198.51.100.7");
  assert.equal(limited.status, 429, "per-address attempt limit");
  assert.equal(limited.value.error, "too many pairing requests; try again later");
  assert.equal((await pair("198.51.100.8")).status, 200, "other addresses are unaffected");
  assert.equal((await send(port, "/control/v1/pair", { body: { id: randomUUID(), name: "bad\u0007name", tokenHash: hashGatewayToken(ctlToken()) } })).status, 400);

  // Expiry, using the registry directly with a moved clock.
  const registry = new ControlRegistry(new StateStore(tempDir("ap-")));
  const token = ctlToken();
  const result = registry.requestPairing({ id: randomUUID(), name: "late", tokenHash: hashGatewayToken(token) }, null, `${ORIGIN}/#pair`) as { userCode: string };
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 11 * 60_000;
  assert.throws(() => registry.approvePairing({ userCode: result.userCode }), /No pending pairing/);
  assert.throws(() => registry.authenticate(`Bearer ${token}`), /revoked or unknown/);
  Date.now = realNow;
  // A global cap bounds memory regardless of address.
  for (let i = 0; i < 16; i++) registry.requestPairing({ id: randomUUID(), name: "d", tokenHash: hashGatewayToken(ctlToken()) }, `192.0.2.${i}`, "");
  assert.throws(() => registry.requestPairing({ id: randomUUID(), name: "d", tokenHash: hashGatewayToken(ctlToken()) }, "192.0.2.200", ""), /too many pending/);
});

test("public dashboard: secure host cookie, wss CSP, no owner bearer or view-only, loopback unchanged", { skip }, async t => {
  const { router, port, store } = await fixture(t);
  const page = await send(port, "/");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), new RegExp(`connect-src 'self' wss://${HOST.replaceAll(".", "\\.")};`));
  const status = await send(port, "/auth/status");
  assert.equal(status.value.authenticated, false);
  assert.equal(status.value.publicReadonly, false);
  assert.equal(status.value.loginCommand, "aar dashboard url", "no local paths for signed-out visitors");
  const minted = await ownerRequest(store, "dashboard/code", {});
  assert.ok(minted.publicUrl.startsWith(`${ORIGIN}/#code=`));
  assert.equal(minted.url.split("#code=")[1], minted.publicUrl.split("#code=")[1]);
  const code = minted.publicUrl.split("#code=")[1];
  assert.equal((await send(port, "/auth/exchange", { body: { code }, headers: { origin: "http://127.0.0.1" } })).status, 403);
  const exchanged = await send(port, "/auth/exchange", { body: { code }, headers: { origin: ORIGIN } });
  assert.equal(exchanged.status, 200);
  const cookie = String(exchanged.headers["set-cookie"]);
  assert.match(cookie, /^__Host-aar_dashboard=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Secure; Max-Age=/);
  const session = cookie.split(";")[0]!;
  const call = (headers: Record<string, string>) => send(port, "/v1/app/overview", { body: {}, headers });
  assert.equal((await call({ origin: ORIGIN, cookie: session })).status, 200);
  assert.equal((await call({ origin: ORIGIN })).status, 401);
  assert.equal((await call({ origin: "https://evil.example", cookie: session })).status, 403);
  const ownerKey = readFileSync(join(store.dir, "owner.key"), "utf8");
  assert.equal((await call(bearer(ownerKey))).status, 401, "the owner credential is never accepted publicly");
  assert.match(await upgrade(port, { host: HOST, origin: ORIGIN }), / 401 /);
  assert.match(await upgrade(port, { host: HOST, origin: "https://evil.example", cookie: session }), / 403 /);
  assert.match(await upgrade(port, { host: HOST, origin: ORIGIN, cookie: session }), / 101 /);
  // The loopback dashboard keeps its own cookie, origin and owner bearer.
  const dashboard = `http://127.0.0.1:${router.dashboard!.port}`;
  const local = await fetch(`${dashboard}/v1/app/overview`, { method: "POST", headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(local.status, 200);
  const localStatus = await (await fetch(`${dashboard}/auth/status`)).json() as { loginCommand: string };
  assert.match(localStatus.loginCommand, /dashboard url$/);
  assert.notEqual(localStatus.loginCommand, "aar dashboard url");
  assert.equal((await fetch(`${dashboard}/v1/app/overview`, { method: "POST", headers: { origin: dashboard, cookie: session, "content-type": "application/json" }, body: "{}" })).status, 401, "public cookies are not local cookies");
});

test("without a public origin nothing extra listens and the dashboard link is loopback only", { skip }, async t => {
  const store = new StateStore(tempDir("ap-")); store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const router = await startRouter(store, {}, { dashboard: { port: 0, uiDir: uiBuild() } });
  t.after(() => router.close(true));
  assert.equal(router.public, undefined);
  const minted = await ownerRequest(store, "dashboard/code", {});
  assert.equal(minted.publicUrl, undefined);
  assert.equal((await ownerRequest(store, "overview", {})).publicOrigin, undefined);
});
