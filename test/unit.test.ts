import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { jwtExpiryMs, readClaudeFile, readCodexFile } from "../src/credentials.ts";
import { authorize, generateGatewayToken, hashGatewayToken, presentedToken } from "../src/gateway-auth.ts";
import { sanitize } from "../src/log.ts";
import { parseUpstreamOrigin } from "../src/providers.ts";
import { validateAccounts, validateConfig } from "../src/state.ts";
import type { GatewayClientRecord } from "../src/types.ts";
import { fakeJwt, tempDir, writeClaudeCredentials, writeCodexAuth } from "./support.ts";

describe("gateway tokens", () => {
  const token = generateGatewayToken();
  const clients: GatewayClientRecord[] = [
    { id: "c1", name: "laptop", tokenSha256: hashGatewayToken(token), createdAt: "", accounts: { claude: "claude-a" } },
  ];

  test("tokens are high-entropy and only hashes are compared", () => {
    assert.match(token, /^aar_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateGatewayToken(), token);
    assert.equal(hashGatewayToken(token).length, 64);
  });

  test("bearer and x-api-key presentation are both accepted", () => {
    assert.equal(presentedToken({ authorization: `Bearer ${token}` }), token);
    assert.equal(presentedToken({ "x-api-key": token }), token);
    assert.equal(presentedToken({ authorization: "Basic abc" }), undefined);
  });

  test("missing, unknown, revoked and unauthorized-provider tokens are denied", () => {
    assert.deepEqual(authorize(clients, {}, "claude"), { ok: false, status: 401, message: "missing or malformed gateway token" });
    assert.equal(authorize(clients, { authorization: `Bearer ${generateGatewayToken()}` }, "claude").ok, false);
    const ok = authorize(clients, { authorization: `Bearer ${token}` }, "claude");
    assert.equal(ok.ok && ok.accountId, "claude-a");
    const codex = authorize(clients, { authorization: `Bearer ${token}` }, "codex");
    assert.equal(!codex.ok && codex.status, 403);
    const revoked = [{ ...clients[0]!, revokedAt: "2026-10-02T00:00:00Z" }];
    const denied = authorize(revoked, { authorization: `Bearer ${token}` }, "claude");
    assert.equal(!denied.ok && denied.status, 401);
  });
});

describe("credential readers", () => {
  test("codex file reader returns access token, expiry and account, never the refresh token", async () => {
    const home = tempDir();
    const access = fakeJwt(2_000_000_000, "a");
    writeCodexAuth(home, access, "acct-1");
    const result = await readCodexFile(home);
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.credential.accessToken, access);
    assert.equal(result.credential.accountId, "acct-1");
    assert.equal(result.credential.expiresAt, 2_000_000_000_000);
    assert.doesNotMatch(JSON.stringify(result), /SECRET-REFRESH/);
  });

  test("codex reader distinguishes missing, keyring, API-key-only and malformed stores", async () => {
    const home = tempDir();
    assert.equal((await readCodexFile(home)).status, "missing");
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    assert.equal((await readCodexFile(home)).status, "unsupported");
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic", tokens: null }));
    assert.equal((await readCodexFile(home)).status, "unsupported");
    writeFileSync(join(home, "auth.json"), '{"tokens": {"access_tok');
    assert.equal((await readCodexFile(home)).status, "malformed");
  });

  test("claude file reader uses stored expiresAt", async () => {
    const home = tempDir();
    writeClaudeCredentials(home, "claude-access", 1_900_000_000_000);
    const result = await readClaudeFile(home);
    assert.ok(result.status === "ok");
    assert.equal(result.credential.accessToken, "claude-access");
    assert.equal(result.credential.expiresAt, 1_900_000_000_000);
    assert.doesNotMatch(JSON.stringify(result), /SECRET-REFRESH/);
  });

  test("jwt expiry tolerates non-JWT tokens", () => {
    assert.equal(jwtExpiryMs("opaque"), undefined);
    assert.equal(jwtExpiryMs("a.b.c"), undefined);
  });
});

describe("log sanitization", () => {
  test("redacts token families and key/value secrets", () => {
    const text = sanitize(
      `Bearer abc123 access_token=xyz "refresh_token": "r1" ${fakeJwt(1, "n")} sk-ant-oat01-SYNTH aar_${"x".repeat(43)}`,
    );
    assert.doesNotMatch(text, /abc123|xyz|"r1"|eyJ|oat01|aar_x/);
  });

  test("bounds length and removes newlines", () => {
    const text = sanitize("a\n".repeat(1000));
    assert.ok(text.length <= 301);
    assert.doesNotMatch(text, /\n/);
  });
});

describe("configuration validation", () => {
  test("listener must be loopback", () => {
    assert.throws(() => validateConfig({ listen: { host: "0.0.0.0", port: 1 } }));
    assert.doesNotThrow(() => validateConfig({ listen: { host: "127.0.0.1", port: 0 } }));
  });

  test("upstream overrides must be https or loopback http bare origins", () => {
    assert.throws(() => parseUpstreamOrigin("http://example.com"));
    assert.throws(() => parseUpstreamOrigin("https://example.com/path"));
    assert.doesNotThrow(() => parseUpstreamOrigin("http://127.0.0.1:9"));
    assert.doesNotThrow(() => parseUpstreamOrigin("https://api.anthropic.com"));
  });

  test("accounts cannot share a profile home", () => {
    assert.throws(() =>
      validateAccounts([
        { id: "a", provider: "codex", home: "/tmp/p" },
        { id: "b", provider: "codex", home: "/tmp/p/" },
      ]),
    );
  });
});
