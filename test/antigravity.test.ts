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

function controlRequest(socketPath: string, path: string, method: "GET" | "POST", token?: string, body?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request({
      socketPath,
      path,
      method,
      headers: {
        host: "localhost",
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

test("Antigravity control: catalog, quotas, pools, selection, bindings and revocation", { skip: process.platform === "win32" }, async (t) => {
  const logs = captureLogs();
  const futureReset = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const weeklyReset = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const untouchedWeekly = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const upstream = await mockUpstream((req, res) => {
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
  const router = await startRouter(store, {}, { eventLog: false });
  t.after(() => router.close(true));
  const sock = router.controlSocket!;

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

  const selection = await controlRequest(sock, "/v1/selection", "POST", ctlToken, { provider: "antigravity" });
  assert.equal(selection.status, 200);
  assert.equal(selection.body.pools.length, 1);
  const accA = selection.body.accounts.find((a: any) => a.id === "agy-a");
  assert.deepEqual(accA.models.map((m: any) => m.id), ["gemini-4-neon", "claude-sonnet-5-5", "gpt-oss-120b-medium"]);
  assert.equal(accA.models[0].defaultReasoningEffort, "high");
  assert.equal(accA.models[0].supportsEffort, true);
  assert.equal(accA.models[2].supportsEffort, false);

  const bindingId = randomUUID();
  const bindingToken = generateGatewayToken();
  const prepared = await controlRequest(sock, "/v1/pools/prepare", "POST", ctlToken, {
    id: bindingId,
    poolId,
    provider: "antigravity",
    model: "gemini-4-neon",
    thinking: "on:high",
    tokenHash: hashGatewayToken(bindingToken),
  });
  assert.equal(prepared.status, 200);
  // Most remaining picks agy-b (85% vs 20% headroom on gemini windows).
  assert.equal(prepared.body.accountId, "agy-b");

  const committed = await controlRequest(sock, "/v1/bindings/commit", "POST", ctlToken, { id: bindingId });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.state, "committed");
  // `agy` cannot authenticate to the router, so no direct transport is described.
  assert.equal(prepared.body.transport, undefined);
  assert.equal(committed.body.transport, undefined);

  const streamRes = await fetch(`${router.origin}/antigravity/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { authorization: `Bearer ${bindingToken}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(streamRes.status, 200);
  assert.match(await streamRes.text(), /"account":"b"/);

  // Untouched 3p weekly bucket has resetsAt=null (unstarted).
  const quotas = await controlRequest(sock, "/v1/quotas", "POST", ctlToken, { accountId: "agy-a" });
  assert.equal(quotas.status, 200);
  const threePWeekly = quotas.body.windows.find((w: any) => w.bucket === "3p-weekly");
  assert.equal(threePWeekly.remainingPercent, 100);
  assert.equal(threePWeekly.resetsAt, null);

  // Revocation cuts off subsequent inference.
  const disconnected = await controlRequest(sock, "/v1/disconnect", "POST", ctlToken, {});
  assert.equal(disconnected.status, 200);
  const afterRevoke = await fetch(`${router.origin}/antigravity/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { authorization: `Bearer ${bindingToken}`, "content-type": "application/json" },
    body: "{}",
  });
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
