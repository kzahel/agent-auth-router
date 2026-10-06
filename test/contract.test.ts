import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { sanitizeCliModels } from "../src/contract.ts";
import { hashGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { FIXTURES, mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

test("CLI model rows are type-checked, bounded and stripped of unknown fields", () => {
  assert.equal(sanitizeCliModels(undefined), undefined);
  assert.equal(sanitizeCliModels({ value: "default" }), undefined);
  assert.deepEqual(sanitizeCliModels([]), []);
  assert.deepEqual(sanitizeCliModels([
    { value: "sonnet", displayName: "Sonnet", description: "", resolvedModel: 5, supportsFastMode: "yes", extra: "dropped" },
    { value: "best", displayName: "", resolvedModel: null, supportsAutoMode: false, supportedEffortLevels: ["max", "max", "turbo"] },
    { value: "" }, "row", null,
  ]), [
    { value: "sonnet", displayName: "Sonnet" },
    { value: "best", displayName: "best", supportsAutoMode: false, supportedEffortLevels: ["max"] },
  ]);
});

// The selection response YA reads, from a synthetic account and the fake CLI.
// Regenerate with AAR_UPDATE_CONTRACT=1 after an intended contract change, and
// copy the file to Yep Anywhere's fixture so its parser test follows.
const CONTRACT = join(FIXTURES, "contract", "selection-claude.json");

function request(socketPath: string, path: string, token?: string, body?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: body ? "POST" : "GET", headers: { host: "localhost", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve(JSON.parse(text)));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("the Claude selection response matches the checked-in contract fixture", { skip: process.platform === "win32" }, async t => {
  const store = new StateStore(tempDir("ct-")); store.init();
  const home = join(store.dir, "profiles", "work"); mkdirSync(home, { recursive: true });
  writeClaudeCredentials(home, "synthetic-provider-secret", Date.now() + 3600_000);
  store.saveAccounts([{ id: "work", provider: "claude", home }]);
  const upstream = await mockUpstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "claude-opus-fixture-2", display_name: "Claude Opus Fixture 2", max_input_tokens: 1_000_000,
        capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: true } }, thinking: { types: { adaptive: { supported: true } } } } },
      { id: "claude-sonnet-fixture-2", display_name: "Claude Sonnet Fixture 2", max_input_tokens: 1_000_000,
        capabilities: { effort: { supported: true, high: { supported: true } }, thinking: { types: { adaptive: { supported: true } } } } },
      { id: "claude-haiku-fixture-1", display_name: "Claude Haiku Fixture 1", max_input_tokens: 200_000, capabilities: { effort: { supported: false } } },
    ] }));
  });
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstream.origin } });
  const router = await startRouter(store, { claudeCommand: process.execPath, claudeArgs: [join(FIXTURES, "fake-claude-cli.ts"), "ok"] });
  t.after(() => router.close());
  const socket = router.controlSocket!, token = `aar_ctl_${randomBytes(32).toString("base64url")}`, id = randomUUID();
  await request(socket, "/v1/pair", undefined, { id, name: "Contract", tokenHash: hashGatewayToken(token) });
  const poolId = "00000000-0000-4000-8000-000000000001";
  await ownerRequest(store, "pools/save", { id: poolId, name: "Work", revision: 0, provider: "claude", policy: "round-robin", accountIds: ["work"] });
  await ownerRequest(store, "grants/save", { id, revision: 1, poolIds: [poolId], accountIds: ["work"] });

  const selection = await request(socket, "/v1/selection", token, { provider: "claude" });
  const normalized = JSON.parse(JSON.stringify(selection), (_key, value) =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? "<timestamp>" : value);
  if (process.env.AAR_UPDATE_CONTRACT === "1") {
    mkdirSync(join(FIXTURES, "contract"), { recursive: true });
    writeFileSync(CONTRACT, JSON.stringify(normalized, null, 2) + "\n");
  }
  assert.deepEqual(normalized, JSON.parse(readFileSync(CONTRACT, "utf8")));
});
