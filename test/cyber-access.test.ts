import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { captureLogs, fakeJwt, mockUpstream, tempDir, writeCodexAuth } from "./support.ts";

test("cyber access HTTP outcomes retain account, model and program without recording content", async (t) => {
  captureLogs();
  const store = new StateStore(tempDir("cyber-"));
  store.init();
  const accounts = ["a", "b"].map((id) => {
    const home = join(store.profilesDir, id);
    mkdirSync(home);
    writeCodexAuth(home, fakeJwt(Math.floor(Date.now() / 1000) + 3600, id));
    return { id, home, provider: "codex" as const, helper: { kind: "none" as const } };
  });
  store.saveAccounts(accounts);
  const tokens = accounts.map(() => generateGatewayToken());
  store.saveClients(
    accounts.map((a, i) => ({
      id: a.id,
      name: `client-${a.id}`,
      accounts: { codex: a.id },
      tokenSha256: hashGatewayToken(tokens[i]!),
      createdAt: new Date().toISOString(),
    })),
  );
  let status = 403;
  const upstream = await mockUpstream((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end('{"message":"SECRET RESPONSE"}');
  });
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { codex: upstream.origin } });
  const router = await startRouter(store);
  t.after(() => router.close());
  const send = async (account: number, program: unknown, model = "model-a", compressed = false) => {
    const body = Buffer.from(JSON.stringify({ model, access_programs: { cyber: program }, input: "SECRET PROMPT" }));
    const wire = compressed ? zstdCompressSync(body) : body;
    const response = await fetch(`${router.origin}/codex/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[account]}`, "content-type": "application/json", ...(compressed ? { "content-encoding": "zstd" } : {}) },
      body: wire,
    });
    assert.equal(response.status, status);
    assert.equal(await response.text(), '{"message":"SECRET RESPONSE"}');
    assert.deepEqual(upstream.requests.at(-1)!.raw, wire, "inspection never rewrites the request");
  };
  await send(0, "daybreak_blue", "model-a", true);
  await send(1, "daybreak_blue");
  await send(0, "daybreak_red", "model-b");
  status = 429;
  await send(0, "standard");
  status = 200;
  await send(0, "daybreak_blue");
  status = 403;
  await send(0, undefined);
  await send(0, "SECRET unknown program");
  await send(0, { value: "daybreak_blue" });
  await send(0, "daybreak_blue", "x".repeat(201));
  await router.close();
  const text = readdirSync(join(store.dir, "events"))
    .map((name) => readFileSync(join(store.dir, "events", name), "utf8"))
    .join("");
  const events = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const access = events.filter((e) => e.type === "cyber-access");
  assert.deepEqual(
    access.map((e) => [e.accountId, e.model, e.program, e.status]),
    [
      ["a", "model-a", "daybreak_blue", 403],
      ["b", "model-a", "daybreak_blue", 403],
      ["a", "model-b", "daybreak_red", 403],
      ["a", "model-a", "standard", 429],
      ["a", "model-a", "daybreak_blue", 200],
    ],
  );
  for (const event of access) {
    const request = events.find((e) => e.type === "request" && e.requestId === event.requestId);
    assert.equal(request?.accountId, event.accountId);
    assert.equal(request?.status, event.status);
    assert.deepEqual(Object.keys(event).sort(), ["accountId", "at", "model", "program", "requestId", "status", "type", "v"]);
  }
  assert.doesNotMatch(text, /SECRET|refresh_token|access_token|profiles/);
  for (const token of tokens) assert.ok(!text.includes(token));
});
