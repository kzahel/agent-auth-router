import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { startAntigravityBridge } from "../src/antigravity-client.ts";
import { normalizeAntigravityQuotas, parseAntigravityCatalog } from "../src/antigravity-cloudcode.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { captureLogs, mockUpstream, tempDir } from "./support.ts";

test("the Antigravity bridge streams through AAR with only the enrolled access token sent upstream", { skip: process.platform === "win32" }, async (t) => {
  const logs = captureLogs();
  const upstream = await mockUpstream((_req, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"response":{"candidates":[]}}\n\n');
    response.end();
  });
  const store = new StateStore(tempDir());
  store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { antigravity: upstream.origin } });
  const home = tempDir();
  const cliProfile = join(home, ".gemini", "antigravity-cli");
  await mkdir(cliProfile, { recursive: true });
  const access = "synthetic-google-access";
  const refresh = "synthetic-google-refresh";
  await writeFile(join(cliProfile, "antigravity-oauth-token"), JSON.stringify({
    auth_method: "consumer", token: { access_token: access, refresh_token: refresh, expiry: new Date(Date.now() + 3_600_000).toISOString() },
  }), { mode: 0o600 });
  store.saveAccounts([{ id: "own-google", provider: "antigravity", home }]);
  store.saveSettings({ requestCompression: {}, experimentalProviders: { antigravity: true } });
  const token = generateGatewayToken();
  const client = { id: "client", name: "test host", createdAt: new Date().toISOString(), tokenSha256: hashGatewayToken(token), accounts: { antigravity: "own-google" } };
  store.saveClients([client]);
  const publicHost = "aar.example.test";
  const router = await startRouter(store, {}, { eventLog: false, public: { origin: `https://${publicHost}`, port: 0 } });
  t.after(() => router.close(true));

  const tokenFile = join(tempDir(), "gateway-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const clientHome = tempDir();
  const bridge = await startAntigravityBridge({ gateway: router.origin, home: clientHome, tokenFile });
  t.after(() => bridge.close());
  const profile = await readFile(join(clientHome, "antigravity-cli", "antigravity-oauth-token"), "utf8");
  assert.ok(!profile.includes(token));
  const { token: { access_token: marker } } = JSON.parse(profile);
  const path = "/v1internal:streamGenerateContent?alt=sse";
  const body = gzipSync(JSON.stringify({ model: "fixture", request: { contents: [{ text: "private prompt fixture" }] } }));
  const post = (endpoint: string, authorization: string) => fetch(endpoint, { method: "POST", headers: {
    authorization, "content-encoding": "gzip", "content-type": "application/json",
  }, body });
  const unauthenticated = await post(`${bridge.endpoint}${path}`, `Bearer ${token}`);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.text();
  const refused = await post(`${bridge.endpoint}/v1internal:writeTrajectoryAcls`, `Bearer ${marker}`);
  assert.equal(refused.status, 404);
  await refused.text();
  // The router's own route table answers before it reads a token. An integration that forwards unfiltered relies on this.
  const bare = async (method: string, rpc: string) => {
    const response = await fetch(`${router.origin}/antigravity/v1internal:${rpc}`, { method });
    await response.text();
    return response.status;
  };
  assert.deepEqual([await bare("POST", "writeTrajectoryAcls"), await bare("GET", "streamGenerateContent"), await bare("POST", "streamGenerateContent")], [404, 405, 401]);
  assert.equal(upstream.requests.length, 0);

  const response = await post(`${bridge.endpoint}${path}`, `Bearer ${marker}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.match(await response.text(), /^data: /);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0]?.url, path);
  assert.equal(upstream.requests[0]?.headers.authorization, `Bearer ${access}`);
  assert.deepEqual(upstream.requests[0]?.raw, body);
  const captured = logs.join("\n");
  for (const secret of [access, refresh, token, marker, "private prompt fixture"]) assert.ok(!captured.includes(secret));

  const hostedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const hosted = request({ host: "127.0.0.1", port: router.public!.port, path: `/antigravity${path}`, method: "POST", headers: {
      host: publicHost, authorization: `Bearer ${token}`,
    } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    hosted.on("error", reject);
    hosted.end("{}");
  });
  assert.equal(hostedStatus, 200);
  assert.equal(upstream.requests[1]?.headers.authorization, `Bearer ${access}`);

  store.saveClients([{ ...client, revokedAt: new Date().toISOString() }]);
  const revoked = await post(`${bridge.endpoint}${path}`, `Bearer ${marker}`);
  assert.equal(revoked.status, 401);
  await revoked.text();
  assert.equal(upstream.requests.length, 2);
});

/** A control request over the owner-only socket, or as the TLS proxy forwards one to the public listener. */
function controlRequest(target: string | { port: number; host: string }, path: string, method: "GET" | "POST", token?: string, body?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request({
      ...(typeof target === "string" ? { socketPath: target } : { host: "127.0.0.1", port: target.port }),
      path: typeof target === "string" ? path : `/control${path}`,
      method,
      headers: {
        host: typeof target === "string" ? "localhost" : target.host,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("Antigravity control: off until the owner turns it on, then catalog, quotas, pools, bindings and revocation", { skip: process.platform === "win32" }, async (t) => {
  const logs = captureLogs();
  const futureReset = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const weeklyReset = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const untouchedWeekly = new Date(Date.now() + 7 * 86_400_000).toISOString();

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const upstream = await mockUpstream((req, res, recorded) => {
    const auth = req.headers.authorization;
    const isSecond = auth === "Bearer access-b";
    if (req.url === "/v1internal:fetchAvailableModels") {
      assert.match(String(req.headers["user-agent"] ?? ""), /^antigravity\//);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        defaultAgentModelId: "gemini-4-neon-high",
        agentModelSorts: [{
          groups: [{
            modelIds: ["gemini-4-neon-high", "gemini-4-neon-low", "claude-sonnet-5-5-medium", "gpt-oss-120b-medium", "gemini-4-carbon-disabled"],
          }],
        }],
        groupedModels: {
          "gemini-4-neon": {
            displayName: "Gemini 4 Neon",
            supportedThinkingLevels: [
              { thinkingSuffix: "low", thinkingDisplayName: "Low" },
              { thinkingSuffix: "high", thinkingDisplayName: "High" },
            ],
          },
          "claude-sonnet-5-5": {
            displayName: "Claude Sonnet 5.5",
            supportedThinkingLevels: [{ thinkingSuffix: "medium", thinkingDisplayName: "Medium" }],
          },
        },
        models: {
          "gemini-4-neon-high": { displayName: "Gemini 4 Neon (High)", maxTokens: 1_048_576 },
          "gemini-4-neon-low": { displayName: "Gemini 4 Neon (Low)", maxTokens: 1_048_576 },
          "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)", maxTokens: 1_000_000 },
          "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", maxTokens: 131_072 },
          "gemini-4-carbon-disabled": { displayName: "Gemini 4 Carbon", disabled: true, maxTokens: 1_048_576 },
        },
      }));
      return;
    }
    if (req.url === "/v1internal:retrieveUserQuotaSummary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        groups: [
          {
            buckets: [
              { bucketId: "gemini-5h", window: "5h", remainingFraction: isSecond ? 0.9 : 0.2, resetTime: futureReset, description: "used" },
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: isSecond ? 0.85 : 0.4, resetTime: weeklyReset, description: "used" },
            ],
          },
          {
            buckets: [
              { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: new Date(Date.now() + 5 * 3_600_000).toISOString() },
              { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: untouchedWeekly },
            ],
          },
        ],
      }));
      return;
    }
    if (req.url?.startsWith("/v1internal:streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (recorded.body.includes("hold")) {
        res.write('data: {"part":1}\n\n');
        void held.then(() => res.end('data: {"part":2}\n\n'));
        return;
      }
      res.end(`data: {"account":"${isSecond ? "b" : "a"}"}\n\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const store = new StateStore(tempDir());
  store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { antigravity: upstream.origin } });
  const writeAccount = async (id: string, accessToken: string) => {
    const home = tempDir();
    const dir = join(home, ".gemini", "antigravity-cli");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "antigravity-oauth-token"), JSON.stringify({
      auth_method: "consumer",
      token: { access_token: accessToken, refresh_token: `refresh-${id}`, expiry: new Date(Date.now() + 3_600_000).toISOString() },
    }), { mode: 0o600 });
    return { id, provider: "antigravity" as const, home };
  };
  store.saveAccounts([await writeAccount("agy-a", "access-a"), await writeAccount("agy-b", "access-b")]);
  const publicHost = "aar.example.test";
  const router = await startRouter(store, {}, { eventLog: false, public: { origin: `https://${publicHost}`, port: 0 } });
  t.after(() => router.close(true));
  const sock = router.controlSocket!;
  // An integration paired over the socket reaches the same control handler through the public listener.
  const transports = [sock, { port: router.public!.port, host: publicHost }];

  const info = await controlRequest(sock, "/v1/info", "GET");
  assert.equal(info.status, 200);
  assert.ok(info.body.capabilities.includes("antigravity-control-v1"));

  const ctlToken = `aar_ctl_${"a".repeat(43)}`;
  const integrationId = randomUUID();
  const paired = await controlRequest(sock, "/v1/pair", "POST", undefined, {
    id: integrationId,
    name: "YA test",
    tokenHash: hashGatewayToken(ctlToken),
  });
  assert.equal(paired.status, 200);

  const poolId = randomUUID();
  const savedPool = await ownerRequest(store, "pools/save", {
    id: poolId,
    name: "Google Pool",
    provider: "antigravity",
    policy: "most-remaining",
    accountIds: ["agy-a", "agy-b"],
    revision: 0,
  });
  assert.equal(savedPool.provider, "antigravity");
  await ownerRequest(store, "grants/save", { id: integrationId, revision: 1, poolIds: [poolId], accountIds: [] });

  const bindingId = randomUUID();
  const bindingToken = generateGatewayToken();
  const poolBinding = { id: bindingId, poolId, provider: "antigravity", model: "gemini-4-neon", thinking: "on:high", tokenHash: hashGatewayToken(bindingToken) };
  const infer = (origin = router.origin, body = "{}") => fetch(`${origin}/antigravity/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { authorization: `Bearer ${bindingToken}`, "content-type": "application/json" }, body,
  });
  // Older Yep Anywhere builds quote a refusal only when it is plain words.
  const off = { code: "provider_disabled", provider: "antigravity", error: "Antigravity routing is turned off; the router owner can turn it on in AAR Settings" };
  assert.match(off.error, /^[A-Za-z][A-Za-z ,;:'()-]{0,159}$/);
  const toggle = (enabled: boolean) => ownerRequest(store, "settings/experimental-providers", { provider: "antigravity", enabled });
  /** While the provider is off an integration is offered nothing of it, and each operation that would use it says why. */
  const assertOffered = async (offered: boolean, refused: [string, object][]) => {
    for (const transport of transports) {
      const selection = await controlRequest(transport, "/v1/selection", "POST", ctlToken, { provider: "antigravity" });
      assert.equal(selection.status, 200);
      const overview = await controlRequest(transport, "/v1/overview", "POST", ctlToken, {});
      for (const listing of [selection.body, overview.body]) {
        assert.deepEqual([listing.pools.length, listing.accounts.length, listing.disabledProviders], offered ? [1, 2, undefined] : [0, 0, ["antigravity"]]);
      }
      for (const [path, body] of refused) {
        const reply = await controlRequest(transport, path, "POST", ctlToken, body);
        if (offered) assert.equal(reply.status, 200, path);
        else assert.deepEqual([path, reply.status, reply.body], [path, 409, off]);
      }
    }
  };
  // The setting is the owner's: an integration's credential cannot change it over either transport.
  const flip = { provider: "antigravity", enabled: true };
  assert.deepEqual([(await controlRequest(sock, "/v1/owner/settings/experimental-providers", "POST", ctlToken, flip)).status,
    (await controlRequest(transports[1]!, "/v1/owner/settings/experimental-providers", "POST", ctlToken, flip)).status], [401, 404]);

  // Off by default: nothing is offered, nothing is admitted, and the router sends nothing upstream, even for its owner.
  assert.deepEqual(await ownerRequest(store, "settings/experimental-providers"), { providers: { antigravity: false } });
  await assertOffered(false, [["/v1/pools/prepare", poolBinding], ["/v1/quotas", { accountId: "agy-a" }], ["/v1/catalog", { accountId: "agy-a" }]]);
  const refreshed = await ownerRequest(store, "accounts/refresh", { id: "agy-a" });
  assert.equal(refreshed.accounts.find((a: any) => a.id === "agy-a").error, off.error);
  assert.equal(upstream.requests.length, 0);
  await assert.rejects(toggle("yes" as unknown as boolean), /true or false/);
  await assert.rejects(ownerRequest(store, "settings/experimental-providers", { provider: "claude", enabled: true }), /invalid experimental provider/);

  // Turning it on uses the grants already saved.
  assert.deepEqual(await toggle(true), { providers: { antigravity: true } });
  const selection = await controlRequest(sock, "/v1/selection", "POST", ctlToken, { provider: "antigravity" });
  assert.equal(selection.status, 200);
  assert.equal(selection.body.pools.length, 1);
  const accA = selection.body.accounts.find((a: any) => a.id === "agy-a");
  assert.deepEqual(accA.models.map((m: any) => m.id), ["gemini-4-neon", "claude-sonnet-5-5", "gpt-oss-120b-medium"]);
  assert.equal(accA.models[0].defaultReasoningEffort, "high");
  assert.equal(accA.models[0].supportsEffort, true);
  assert.equal(accA.models[2].supportsEffort, false);

  const prepared = await controlRequest(sock, "/v1/pools/prepare", "POST", ctlToken, poolBinding);
  assert.equal(prepared.status, 200);
  // Most remaining picks agy-b (85% vs 20% headroom on gemini windows).
  assert.equal(prepared.body.accountId, "agy-b");

  const committed = await controlRequest(sock, "/v1/bindings/commit", "POST", ctlToken, { id: bindingId });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.state, "committed");
  // The route is described like any other. Its Cloud Code RPCs are the adapter's, so there is no catalog path.
  const transport = { kind: "http-gateway-v1", basePath: "/antigravity", authMethods: ["bearer"] };
  assert.deepEqual([prepared.body.transport, committed.body.transport], [transport, transport]);

  const streamRes = await infer();
  assert.equal(streamRes.status, 200);
  assert.match(await streamRes.text(), /"account":"b"/);

  // Untouched 3p weekly bucket has resetsAt=null (unstarted).
  const quotas = await controlRequest(sock, "/v1/quotas", "POST", ctlToken, { accountId: "agy-a" });
  assert.equal(quotas.status, 200);
  const threePWeekly = quotas.body.windows.find((w: any) => w.bucket === "3p-weekly");
  assert.equal(threePWeekly.remainingPercent, 100);
  assert.equal(threePWeekly.resetsAt, null);

  // Turning it off refuses new inference on the pin and every use of the provider. A stream already accepted drains.
  const draining = await infer(router.origin, '{"hold":true}');
  assert.equal(draining.status, 200);
  const reader = draining.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"part":1/);
  const grants = async () => (await ownerRequest(store, "overview")).integrations.find((i: any) => i.id === integrationId);
  const granted = await grants();
  assert.deepEqual(await toggle(false), { providers: { antigravity: false } });
  const sent = upstream.requests.length;
  const refusedInference = await infer();
  assert.deepEqual([refusedInference.status, (await refusedInference.json() as any).error.message], [403, off.error]);
  const hostedInference = await new Promise<number | undefined>((resolve, reject) => {
    const hosted = request({ host: "127.0.0.1", port: router.public!.port, path: "/antigravity/v1internal:streamGenerateContent?alt=sse", method: "POST",
      headers: { host: publicHost, authorization: `Bearer ${bindingToken}` } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    hosted.on("error", reject);
    hosted.end("{}");
  });
  assert.equal(hostedInference, 403);
  await assertOffered(false, [["/v1/bindings/inspect", { id: bindingId }], ["/v1/bindings/commit", { id: bindingId }], ["/v1/pools/prepare", poolBinding]]);
  assert.equal(upstream.requests.length, sent);
  // The grant listing still names the pinned account, so a resume is told the provider is off, not that its account is gone.
  const listed = await controlRequest(sock, "/v1/accounts", "GET", ctlToken);
  assert.deepEqual(listed.body.accounts.map((a: any) => [a.id, a.enabled]), [["agy-a", true], ["agy-b", true]]);
  release();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"part":2/);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(await grants(), granted);

  // Turning it back on restores the same pin and grants.
  await toggle(true);
  await assertOffered(true, [["/v1/bindings/inspect", { id: bindingId }]]);
  const inspected = await controlRequest(sock, "/v1/bindings/inspect", "POST", ctlToken, { id: bindingId });
  assert.deepEqual([inspected.body.state, inspected.body.accountId], ["committed", "agy-b"]);
  const resumed = await infer();
  assert.equal(resumed.status, 200);
  assert.match(await resumed.text(), /"account":"b"/);

  // Revocation cuts off subsequent inference.
  const disconnected = await controlRequest(sock, "/v1/disconnect", "POST", ctlToken, {});
  assert.equal(disconnected.status, 200);
  const afterRevoke = await infer();
  assert.equal(afterRevoke.status, 401);
  await afterRevoke.text();

  const captured = logs.join("\n");
  for (const secret of ["access-a", "access-b", "refresh-agy-a", "refresh-agy-b", bindingToken, ctlToken]) {
    assert.ok(!captured.includes(secret), `log leaked secret ${secret}`);
  }

  // Unit checks for parsers.
  assert.equal(parseAntigravityCatalog({}), null);
  assert.deepEqual(normalizeAntigravityQuotas({}), []);
});

test("turning Antigravity off stops work already under way before it reaches Google again", { skip: process.platform === "win32" }, async (t) => {
  // Each upstream reply is held until the test lets it go, and is then a 401, which would normally start a recovery and a retry.
  let replies: (() => void)[] = [];
  const upstream = await mockUpstream((_req, res) => { replies.push(() => { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); }); });
  const store = new StateStore(tempDir());
  store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { antigravity: upstream.origin } });
  const home = tempDir();
  const tokenFile = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  let logins = 0;
  // A different stored login is what recovery looks for after a 401: without the setting it would be sent upstream.
  const signIn = () => writeFile(tokenFile, JSON.stringify({ auth_method: "consumer",
    token: { access_token: `access-${++logins}`, refresh_token: "refresh", expiry: new Date(Date.now() + 3_600_000).toISOString() } }), { mode: 0o600 });
  await signIn();
  store.saveAccounts([{ id: "agy", provider: "antigravity", home, helper: { kind: "none" } }]);
  store.saveSettings({ requestCompression: {}, experimentalProviders: { antigravity: true } });
  const token = generateGatewayToken();
  store.saveClients([{ id: "client", name: "test host", createdAt: new Date().toISOString(), tokenSha256: hashGatewayToken(token), accounts: { antigravity: "agy" } }]);
  const router = await startRouter(store, {}, { eventLog: false });
  t.after(() => router.close(true));
  const toggle = (enabled: boolean) => ownerRequest(store, "settings/experimental-providers", { provider: "antigravity", enabled });
  const sent = async (count: number) => { for (let i = 0; upstream.requests.length < count; i++) { assert.ok(i < 200, `waiting for upstream request ${count}`); await new Promise((r) => setTimeout(r, 10)); } };
  /** The owner turns it off while `count` requests are held upstream; a new login is there for a recovery to find. */
  const turnOffDuring = async (count: number) => {
    await sent(count);
    await signIn();
    await toggle(false);
    for (const reply of replies) reply();
    replies = [];
  };
  const path = "/antigravity/v1internal:streamGenerateContent?alt=sse";

  // Inference: the 401 comes back after the opt-out, so there is no recovery and no second send.
  const inference = fetch(`${router.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  await turnOffDuring(1);
  assert.equal((await inference).status, 401);
  assert.deepEqual(upstream.requests.map((r) => r.headers.authorization), ["Bearer access-1"]);
  // A rejection nobody tried to recover from leaves no sign-in demand and no cooldown behind.
  const account = async () => (await ownerRequest(store, "overview")).accounts.find((a: any) => a.id === "agy");
  const unmarked = async () => assert.deepEqual([router.coordinators.get("agy")!.status().state, (await account()).blocked], ["ready", undefined]);
  await unmarked();

  // The owner's own refresh: neither metadata read is sent again, and renewal is refused outright.
  await toggle(true);
  const refresh = ownerRequest(store, "accounts/refresh", { id: "agy" }).catch(() => undefined);
  await turnOffDuring(3);
  await refresh;
  assert.deepEqual(upstream.requests.slice(1).map((r) => [r.url, r.headers.authorization]).sort(),
    [["/v1internal:fetchAvailableModels", "Bearer access-2"], ["/v1internal:retrieveUserQuotaSummary", "Bearer access-2"]]);
  await unmarked();
  await assert.rejects(ownerRequest(store, "accounts/renew", { id: "agy" }), /Antigravity routing is turned off/);

  // A request authenticated while it was on, whose body arrives after the opt-out, is refused before any send.
  await toggle(true);
  const late = request(`${router.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const answered = new Promise<number | undefined>((resolve, reject) => { late.on("response", (response) => { response.resume(); resolve(response.statusCode); }); late.on("error", reject); });
  late.flushHeaders();
  await new Promise((r) => setTimeout(r, 100));
  await toggle(false);
  late.end("{}");
  assert.equal(await answered, 403);
  assert.equal(upstream.requests.length, 3);
});
