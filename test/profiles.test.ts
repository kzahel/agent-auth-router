import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverProfiles, inspectProfile, profileStore } from "../src/profiles.ts";
import { ownerRequest } from "../src/owner.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore } from "../src/state.ts";
import { accountEnv } from "../src/process.ts";
import { CredentialCoordinator } from "../src/coordinator.ts";
import { credentialReaderFor } from "../src/credentials.ts";
import { tempDir, writeCodexAuth, fakeJwt } from "./support.ts";

const contents = (home: string) => ({ mode: statSync(home).mode, files: readdirSync(home).sort().map(name => [name, statSync(join(home, name)).mode, readFileSync(join(home, name), "utf8")]) });
test("existing enrollment preserves files and permissions, rejects aliases, and follows external credential changes", async t => {
  const store = new StateStore(tempDir("reuse-router-")), home = tempDir("reuse-profile-");
  chmodSync(home, 0o750);
  writeCodexAuth(home, fakeJwt(2_000_000_000, "first"), "synthetic-account");
  writeFileSync(join(home, "unrelated.txt"), "preserve me", { mode: 0o640 });
  const before = contents(home);
  const router = await startRouter(store); t.after(() => router.close());
  const preview = await ownerRequest(store, "profiles/inspect", { provider: "codex", home });
  assert.equal(preview.canEnroll, true); assert.equal(preview.credentialStatus, "ok");
  assert.doesNotMatch(JSON.stringify(preview), /synthetic-account|access_token|refresh|eyJ/);
  await ownerRequest(store, "accounts/add", { id: "existing", provider: "codex", home, enrollment: "existing" });
  assert.deepEqual(contents(home), before, "no config provisioning or chmod");
  const alias = join(tempDir("alias-"), "profile"); symlinkSync(home, alias);
  await assert.rejects(ownerRequest(store, "accounts/add", { provider: "codex", home: alias, enrollment: "existing" }), /already enrolled/);
  const account = store.loadAccounts()[0]!;
  const coordinator = new CredentialCoordinator({ account, read: credentialReaderFor("codex", home), helper: undefined, helperContext: { workDir: store.workDir } });
  const first = await coordinator.credential();
  writeCodexAuth(home, fakeJwt(2_000_000_001, "replacement"), "synthetic-account");
  const second = await coordinator.credential();
  assert.notEqual(first.revision, second.revision);
  assert.equal((await ownerRequest(store, "accounts/login-status", { id: account.id })).credentialStatus, "ok");
});

test("existing profile checks reject unsupported stores, provider overrides and missing folders without changes", async t => {
  const store = new StateStore(tempDir("reject-router-"));
  const router = await startRouter(store); t.after(() => router.close());
  for (const config of ['cli_auth_credentials_store = "keyring"\n', 'model_provider = "gateway"\n']) {
    const home = tempDir("unsupported-profile-");
    writeFileSync(join(home, "config.toml"), config);
    writeCodexAuth(home, fakeJwt(2_000_000_000, "stale-file"), "fixture");
    const before = contents(home);
    assert.equal((await ownerRequest(store, "profiles/inspect", { provider: "codex", home })).canEnroll, false);
    await assert.rejects(ownerRequest(store, "accounts/add", { provider: "codex", home, enrollment: "existing" }));
    assert.deepEqual(contents(home), before);
  }
  const missing = join(tempDir(), "missing");
  await assert.rejects(ownerRequest(store, "accounts/add", { provider: "codex", home: missing, enrollment: "existing" }), /missing/);
  await assert.rejects(ownerRequest(store, "accounts/add", { provider: "codex", enrollment: "existing" }), /Choose/);
  assert.equal(store.loadAccounts().length, 0);
});

test("parallel inspected enrollments preserve both accounts and logged-out profiles need no provisioning", async t => {
  const store = new StateStore(tempDir("parallel-enroll-"));
  const router = await startRouter(store); t.after(() => router.close());
  const homes = [tempDir(), tempDir()];
  await Promise.all(homes.map(home => ownerRequest(store, "accounts/add", { provider: "codex", home, enrollment: "existing" })));
  assert.equal(store.loadAccounts().length, 2);
  for (const home of homes) assert.deepEqual(readdirSync(home), []);
});

test("profile discovery lists only known existing directories without reading credentials", () => {
  const home = tempDir(), other = tempDir(); mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "auth.json"), "invalid-secret-never-read");
  assert.deepEqual(discoverProfiles("codex", home, { CODEX_HOME: other }).map(p => p.home), [join(home, ".codex"), other]);
  assert.equal(discoverProfiles("codex", home, { CODEX_HOME: join(home, ".codex") }).length, 1);
  assert.deepEqual(discoverProfiles("claude", home, {}), []);
});

test("normal Claude Keychain selection is explicit and preserves the CLI's default environment", async () => {
  const home = join(homedir(), ".claude");
  const account = { id: "default", provider: "claude" as const, home, credentialStore: "claude-keychain-default" as const };
  const env = accountEnv(account, { HOME: "/wrong", CLAUDE_CONFIG_DIR: "/wrong", ANTHROPIC_AUTH_TOKEN: "secret", PATH: "/fixture" });
  assert.equal(env.HOME, homedir()); assert.equal(env.CLAUDE_CONFIG_DIR, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  if (process.platform === "darwin") {
    assert.equal(profileStore("claude", home, "auto"), "claude-keychain-default");
    assert.equal(profileStore("claude", home, "claude-keychain"), "claude-keychain");
  }
  assert.throws(() => profileStore("claude", "/not-default", "claude-keychain-default"));
  const existing = tempDir();
  const preview = await inspectProfile({ ...account, home: existing }, async () => ({ status: "ok", credential: { accessToken: "never-emit", revision: "never-emit", accountId: "never-emit", expiresAt: 1 } }));
  assert.equal(preview.credentialStatus, "expired"); assert.doesNotMatch(JSON.stringify(preview), /never-emit/);
});
