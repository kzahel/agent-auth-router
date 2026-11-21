import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { startAntigravityBridge } from "../src/antigravity-client.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
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
