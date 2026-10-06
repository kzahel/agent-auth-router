import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore } from "../src/state.ts";
import { startDashboard } from "../src/dashboard.ts";
import { captureLogs, mockUpstream, tempDir, waitFor, writeClaudeCredentials } from "./support.ts";

const skip = process.platform === "win32";

/** Line-protocol client for the desktop pipe. */
function appSocket(path: string) {
  const socket = net.connect(path);
  const messages: any[] = [];
  let buffer = "", closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { messages.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
  });
  socket.on("close", () => { closed = true; });
  return {
    messages,
    closed: () => closed,
    send: (message: object) => socket.write(JSON.stringify(message) + "\n"),
    async next(predicate: (m: any) => boolean, timeoutMs = 3000) {
      await waitFor(() => messages.some(predicate), timeoutMs);
      return messages.find(predicate);
    },
    close: () => socket.destroy(),
  };
}

/** Minimal masked-frame WebSocket client with explicit headers. */
function webSocket(origin: string, headers: Record<string, string>): Promise<{ status: number; send(text: string): void; messages: any[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/app/ws", origin);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers } });
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode!, send() {}, messages: [], close() {} }); });
    req.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? resolve({ status: 0, send() {}, messages: [], close() {} }) : reject(error));
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      const messages: any[] = [];
      let buffer = Buffer.alloc(0);
      const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let length = buffer[1]! & 0x7f, offset = 2;
          if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) return;
          if ((buffer[0]! & 0x0f) === 1) messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString()));
          buffer = buffer.subarray(offset + length);
        }
      };
      socket.on("data", read);
      read(head);
      resolve({
        status: res.statusCode!,
        messages,
        send(text: string) {
          const payload = Buffer.from(text), mask = randomBytes(4);
          const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
          socket.write(Buffer.concat([header, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))]));
        },
        close: () => socket.destroy(),
      });
    });
    req.end();
  });
}

function httpRequest(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Claude-shaped SSE with a fixed usage, after an optional pause. */
function claudeStream(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: "message_start", message: { model: "claude-fixture", usage: { input_tokens: 7, cache_read_input_tokens: 70, output_tokens: 1 } } });
  send({ type: "content_block_delta", delta: { type: "text_delta", text: "hello world" } });
  setTimeout(() => { send({ type: "message_delta", usage: { output_tokens: 33 } }); res.end(); }, 50);
}

async function fixture(t: { after(fn: () => unknown): void }, upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => claudeStream(res)) {
  captureLogs();
  const upstream = await mockUpstream(upstreamHandler);
  const store = new StateStore(tempDir("aa-"));
  store.init();
  writeFileSync(join(store.dir, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin, codex: upstream.origin } }));
  const home = join(store.profilesDir, "work");
  mkdirSync(home);
  writeClaudeCredentials(home, "synthetic-provider-secret", Date.now() + 3600_000);
  store.saveAccounts([{ id: "work", provider: "claude", home, helper: { kind: "none" } }]);
  const token = generateGatewayToken();
  store.saveClients([{ id: randomUUID(), name: "laptop", tokenSha256: hashGatewayToken(token), createdAt: new Date().toISOString(), accounts: { claude: "work" } }]);
  const router = await startRouter(store, {}, { dashboard: { port: 0 } });
  t.after(() => router.close(true));
  const infer = (body = "{}") => fetch(`${router.origin}/claude/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body }).then((r) => r.text());
  return { store, router, upstream, infer, token, ownerToken: readFileSync(join(store.dir, "owner.key"), "utf8") };
}

test("desktop pipe: owner hello, core-side policy, subscriptions and change events", { skip }, async (t) => {
  const { store, router, infer, ownerToken } = await fixture(t);
  const path = join(store.dir, "app.sock");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const intruder = appSocket(path);
  intruder.send({ hello: { token: "aar_owner_" + "x".repeat(43) } });
  assert.equal((await intruder.next((m) => m.error)).error.status, 401);
  await waitFor(intruder.closed);
  const early = appSocket(path);
  early.send({ id: 1, call: "overview" });
  await early.next((m) => m.error);
  await waitFor(early.closed);
  assert.ok(!early.messages.some((m) => m.result), "no call runs before the owner hello");

  const app = appSocket(path);
  t.after(() => app.close());
  app.send({ hello: { token: ownerToken } });
  assert.equal((await app.next((m) => m.hello)).hello.routerId, (await ownerRequest(store, "overview")).routerId);
  app.send({ id: 1, call: "dashboard/code" });
  assert.equal((await app.next((m) => m.id === 1)).error.message, "unknown app operation", "dashboard administration stays CLI-only");
  app.send({ id: 2, call: "clients/add", body: {} });
  assert.equal((await app.next((m) => m.id === 2)).error.status, 404);
  app.send({ id: 3, hello: { token: ownerToken } });
  assert.equal((await app.next((m) => m.id === 3)).error.status, 409);
  app.send({ id: 4, subscribe: "requests" });
  assert.deepEqual((await app.next((m) => m.id === 4)).result.requests, []);
  app.send({ id: 5, subscribe: "history", body: { range: "2m", scope: "account:work", metrics: ["output", "cacheRead"] } });
  const history = (await app.next((m) => m.id === 5)).result;
  app.send({ id: 6, subscribe: "history", body: { range: "1y" } });
  assert.equal((await app.next((m) => m.id === 6)).error.status, 400);

  // Traffic reaches subscribers with provider figures, and history follows.
  await infer();
  const done = await app.next((m) => m.sub === 4 && m.data.outcome === "ok");
  assert.equal(done.data.client, "laptop");
  assert.equal(done.data.model, "claude-fixture");
  assert.deepEqual(done.data.usage, { input: 7, cacheRead: 70, cacheWrite: 0, output: 33, reasoning: 0 });
  assert.ok(app.messages.some((m) => m.sub === 4 && m.data.outcome === "active"));
  const append = await app.next((m) => m.sub === 5 && m.data.series.output.some((v: number | null) => v), 4000);
  assert.ok(append.data.start > history.completeThrough);
  assert.equal(append.data.series.output.reduce((a: number, b: number | null) => a + (b ?? 0), 0), 33);

  // Registry edits from any owner surface notify connected UIs.
  await ownerRequest(store, "pools/save", { id: randomUUID(), revision: 0, name: "Work", provider: "claude", policy: "manual", accountIds: ["work"] });
  await app.next((m) => m.event === "change");
  if (process.platform === "darwin") {
    app.send({ id: 7, call: "accounts/add", body: { id: "keychain", provider: "claude" } });
    await app.next((m) => m.id === 7 && m.result);
    assert.equal(store.loadAccounts().find((a) => a.id === "keychain")?.credentialStore, "claude-keychain", "UI enrollment matches the official CLI's Mac storage");
  }
  // Nothing of this is served on the inference listener.
  assert.equal((await fetch(`${router.origin}/v1/app/overview`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}` } })).status, 404);
  assert.equal((await fetch(`${router.origin}/`)).status, 404);
});

test("web dashboard: exact host and origin, single-use codes, sessions and logout", { skip }, async (t) => {
  const { store, router, ownerToken } = await fixture(t);
  const dashboard = router.dashboard!;
  const origin = dashboard.origin, host = new URL(origin).host;
  const page = await httpRequest(origin, "/", { headers: { host } });
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  assert.equal((await httpRequest(origin, "/", { headers: { host: "evil.example" } })).status, 403, "DNS rebinding");
  assert.equal((await httpRequest(origin, "/terminal.html", { headers: { host } })).status, 404, "desktop-only assets are not served");

  const code = new URL((await ownerRequest(store, "dashboard/code")).url).hash.slice("#code=".length);
  const exchange = (headers: Record<string, string>) => httpRequest(origin, "/auth/exchange", { method: "POST", headers: { host, "content-type": "application/json", ...headers }, body: JSON.stringify({ code }) });
  assert.equal((await exchange({})).status, 403, "Origin required");
  assert.equal((await exchange({ origin: "http://evil.example" })).status, 403);
  const signedIn = await exchange({ origin });
  assert.equal(signedIn.status, 200);
  const setCookie = String(signedIn.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal((await exchange({ origin })).status, 401, "codes are single-use");

  const sessions = readFileSync(join(store.dir, "dashboard-sessions.json"), "utf8");
  assert.equal(statSync(join(store.dir, "dashboard-sessions.json")).mode & 0o777, 0o600);
  assert.equal(sessions.includes(cookie.split("=")[1]!), false, "only a hash of the session token is stored");
  assert.ok(sessions.includes(createHash("sha256").update(cookie.split("=")[1]!).digest("hex")));

  // WebSockets get no CORS protection: Origin and cookie are both required.
  assert.equal((await webSocket(origin, { host, cookie })).status, 403);
  assert.equal((await webSocket(origin, { host, cookie, origin: "http://evil.example" })).status, 403);
  assert.equal((await webSocket(origin, { host, origin })).status, 401);
  const ws = await webSocket(origin, { host, cookie, origin });
  t.after(() => ws.close());
  assert.equal(ws.status, 101);
  await waitFor(() => ws.messages.some((m) => m.hello?.kind === "web"));
  ws.send(JSON.stringify({ id: 1, call: "overview" }));
  ws.send(JSON.stringify({ id: 2, call: "dashboard/sessions" }));
  ws.send(JSON.stringify({ id: 3, call: "shutdown", body: {} }));
  await waitFor(() => [1, 2, 3].every((id) => ws.messages.some((m) => m.id === id)));
  assert.equal(ws.messages.find((m) => m.id === 1).result.accounts[0].id, "work");
  assert.equal(ws.messages.find((m) => m.id === 2).error.status, 404);
  assert.equal(ws.messages.find((m) => m.id === 3).error.status, 404, "only the desktop shell may force a stop");

  // Plain HTTP calls: browsers need cookie and Origin; scripts may use the owner credential.
  const call = (headers: Record<string, string>) => httpRequest(origin, "/v1/app/metrics/snapshot", { method: "POST", headers: { host, "content-type": "application/json", ...headers }, body: "{}" });
  assert.equal((await call({ cookie })).status, 403);
  assert.equal((await call({ cookie, origin })).status, 200);
  assert.equal((await call({ authorization: `Bearer ${ownerToken}` })).status, 200);
  assert.equal((await call({ authorization: "Bearer aar_owner_wrong" })).status, 401);
  assert.equal((await call({ origin })).status, 401);
  assert.equal((await httpRequest(origin, "/v1/app/metrics/snapshot", { method: "POST", headers: { host, cookie, origin, "content-type": "text/plain" }, body: "{}" })).status, 415);

  assert.equal((await ownerRequest(store, "dashboard/sessions")).sessions.length, 1);
  const logout = await httpRequest(origin, "/auth/logout", { method: "POST", headers: { host, cookie, origin, "content-type": "application/json" }, body: "{}" });
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await webSocket(origin, { host, cookie, origin })).status, 401, "logout ends the session on the server");
  assert.equal((await ownerRequest(store, "dashboard/sessions")).sessions.length, 0);
});

test("a dashboard port conflict fails clearly", { skip }, async (t) => {
  const { store, router } = await fixture(t);
  await assert.rejects(startDashboard({ store, hub: undefined as never, authenticateOwner: () => {}, port: router.dashboard!.port }), /--dashboard-port/);
});

test("the usage tap leaves relayed bytes unchanged and backpressure intact", { skip }, async (t) => {
  const chunk = Buffer.from(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "z".repeat(60_000) } })}\n\n`);
  const total = 32 * 1024 * 1024;
  let written = 0, paused = false;
  const expected = createHash("sha256");
  const { router, token } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const pump = () => {
      while (written < total) {
        written += chunk.length;
        expected.update(chunk);
        if (!res.write(chunk)) { paused = true; res.once("drain", pump); return; }
      }
      res.end();
    };
    pump();
  });
  const url = new URL(router.origin);
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: "/claude/v1/messages", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, resolve);
    req.on("error", reject);
    req.end("{}");
  });
  response.pause();
  // A client that does not read stalls the upstream instead of the router buffering 32 MiB.
  await waitFor(() => paused, 5000);
  await new Promise((r) => setTimeout(r, 300));
  const stalledAt = written;
  assert.ok(stalledAt < total / 2, `upstream stalled at ${stalledAt} bytes`);
  const received = createHash("sha256");
  let bytes = 0;
  response.on("data", (data: Buffer) => { bytes += data.length; received.update(data); });
  response.resume();
  await new Promise((r) => response.on("end", r));
  assert.equal(bytes, written);
  assert.equal(received.digest("hex"), expected.digest("hex"), "relayed bytes are unchanged");
  const entry = router.metrics.recentRequests()[0]!;
  assert.equal(entry.bytesDown, written);
  assert.equal(entry.estimated, true, "a stream without usage keeps a flagged estimate");
});
