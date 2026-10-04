import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { claudeKeychainService, readClaudeKeychain, type KeychainReadOptions } from "../src/credentials.ts";
import { validateAccounts } from "../src/state.ts";
import { FIXTURES, tempDir } from "./support.ts";

function fixture(mode = "read") {
  const home = tempDir();
  const payload = join(home, "payload.json");
  const argv = join(home, "argv.json");
  writeFileSync(payload, JSON.stringify({ claudeAiOauth: { accessToken: "SECRET-SYNTHETIC-ACCESS", refreshToken: "SECRET-SYNTHETIC-REFRESH", expiresAt: 2_000_000_000_000 }, unrelatedSecret: "SECRET-UNRELATED" }));
  const options: KeychainReadOptions = { platform: "darwin", username: "synthetic-user", command: process.execPath, args: [join(FIXTURES, "fake-security.ts"), mode, payload, argv], timeoutMs: 1000 };
  return { home, payload, argv, options };
}

describe("profile-specific Claude Keychain reader", () => {
  test("selects only the enrolled service and OS account, returning only access metadata", async () => {
    const f = fixture();
    const result = await readClaudeKeychain(f.home, f.options);
    assert.ok(result.status === "ok");
    assert.equal(result.credential.accessToken, "SECRET-SYNTHETIC-ACCESS");
    assert.equal(result.credential.expiresAt, 2_000_000_000_000);
    assert.doesNotMatch(JSON.stringify(result), /REFRESH|UNRELATED/);
    const service = `Claude Code-credentials-${createHash("sha256").update(f.home).digest("hex").slice(0, 8)}`;
    assert.deepEqual(JSON.parse(readFileSync(f.argv, "utf8")), ["find-generic-password", "-a", "synthetic-user", "-w", "-s", service]);
    assert.notEqual(claudeKeychainService(f.home + "/other"), service);
  });

  test("rereads replacement credentials rather than caching the previous token", async () => {
    const f = fixture();
    const before = await readClaudeKeychain(f.home, f.options);
    writeFileSync(f.payload, JSON.stringify({ claudeAiOauth: { accessToken: "REPLACEMENT", expiresAt: 2_000_000_001_000 } }));
    const after = await readClaudeKeychain(f.home, f.options);
    assert.ok(before.status === "ok" && after.status === "ok");
    assert.notEqual(before.credential.revision, after.credential.revision);
    assert.equal(after.credential.expiresAt, 2_000_000_001_000);
  });

  test("missing and inaccessible entries do not fall back to a different entry or file", async () => {
    for (const [mode, status] of [["missing", "missing"], ["denied", "malformed"]] as const) {
      const f = fixture(mode);
      writeFileSync(join(f.home, ".credentials.json"), readFileSync(f.payload));
      const result = await readClaudeKeychain(f.home, f.options);
      assert.equal(result.status, status);
      assert.doesNotMatch(JSON.stringify(result), /SECRET|sk-ant/);
    }
  });

  test("malformed JSON, missing access token and non-subscription stores have bounded metadata errors", async () => {
    const f = fixture();
    for (const [body, status] of [["SECRET-INVALID-JSON", "malformed"], ['{"claudeAiOauth":{"refreshToken":"SECRET"}}', "malformed"], ['{"apiKey":"SECRET"}', "unsupported"]] as const) {
      writeFileSync(f.payload, body);
      const result = await readClaudeKeychain(f.home, f.options);
      assert.equal(result.status, status);
      assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    }
  });

  test("bounds output and terminates a stalled process", async () => {
    const large = fixture("oversized");
    const result = await readClaudeKeychain(large.home, large.options);
    assert.ok(result.status === "malformed");
    assert.match(result.reason, /size bound/);
    const hung = fixture("hang");
    const stalled = await readClaudeKeychain(hung.home, { ...hung.options, timeoutMs: 150 });
    assert.ok(stalled.status === "malformed");
    assert.match(stalled.reason, /timed out/);
  });

  test("rejects unscoped profiles, unsupported platforms and invalid store/provider combinations", async () => {
    const f = fixture();
    assert.throws(() => claudeKeychainService(""));
    assert.equal((await readClaudeKeychain("relative", f.options)).status, "malformed");
    assert.equal((await readClaudeKeychain(f.home, { ...f.options, platform: "linux" })).status, "unsupported");
    assert.equal((await readClaudeKeychain(f.home, { ...f.options, username: 'bad"user' })).status, "unsupported");
    assert.throws(() => validateAccounts([{ id: "codex", provider: "codex", home: f.home, credentialStore: "claude-keychain" }]));
    assert.throws(() => validateAccounts([{ id: "claude", provider: "claude", home: f.home, credentialStore: "unknown" as "file" }]));
  });
});

test("explicit normal Claude profile reads only the unsuffixed Keychain service", async () => {
  const f = fixture();
  const result = await readClaudeKeychain(join(homedir(), ".claude"), { ...f.options, defaultProfile: true, cwd: f.home });
  assert.equal(result.status, "ok");
  assert.equal(JSON.parse(readFileSync(f.argv, "utf8")).at(-1), "Claude Code-credentials");
  assert.equal((await readClaudeKeychain(f.home, { ...f.options, defaultProfile: true, cwd: f.home })).status, "malformed");
});
