import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CredentialCoordinator, CredentialUnavailable } from "../src/coordinator.ts";
import { credentialReaderFor } from "../src/credentials.ts";
import { directProviderProblem, helperFor, type HelperOutcome, type RenewalHelper } from "../src/helpers.ts";
import { helperEnv } from "../src/process.ts";
import type { AccountConfig, HelperConfig } from "../src/types.ts";
import { captureLogs, fakeJwt, FIXTURES, tempDir, writeClaudeCredentials, writeCodexAuth } from "./support.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function codexAccount(id: string, mode: string, extra: Partial<HelperConfig> = {}): AccountConfig {
  return {
    id,
    provider: "codex",
    home: tempDir(),
    helper: { kind: "codex-app-server", command: process.execPath, args: [join(FIXTURES, "fake-codex-app-server.ts"), mode], ...extra } as HelperConfig,
  };
}

function claudeAccount(id: string, mode: string, timeoutSeconds = 10): AccountConfig {
  return {
    id,
    provider: "claude",
    home: tempDir(),
    helper: { kind: "command", command: process.execPath, args: [join(FIXTURES, "fake-claude-renew.ts"), mode], timeoutSeconds },
  };
}

function coordinatorFor(account: AccountConfig, helper?: RenewalHelper, now?: () => number): CredentialCoordinator {
  return new CredentialCoordinator({
    account,
    read: credentialReaderFor(account.provider, account.home),
    helper: helper ?? (account.helper ? helperFor(account.helper) : undefined),
    helperContext: { workDir: tempDir("aar-cwd-") },
    ...(now ? { now } : {}),
  });
}

function rpcLog(home: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, "rpc-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("credential coordinator", () => {
  test("a credential outside its renewal window is returned without running a helper", async () => {
    const account = codexAccount("fresh", "renew");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 3600, "fresh"));
    const coordinator = coordinatorFor(account);
    const credential = await coordinator.credential();
    assert.equal(coordinator.status().helperRuns, 0);
    assert.equal(coordinator.status().state, "ready");
    assert.ok(credential.accessToken.length > 0);
  });

  test("concurrent demand for a due credential runs one helper; another account stays independent", async () => {
    captureLogs();
    let running = 0;
    let maxRunning = 0;
    const slowHelper = (write: () => void): RenewalHelper => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      write();
      running--;
      return { outcome: "completed" };
    };
    const a = codexAccount("acct-a", "unused");
    const b = codexAccount("acct-b", "unused");
    writeCodexAuth(a.home, fakeJwt(nowSeconds() + 60, "a-old"));
    writeCodexAuth(b.home, fakeJwt(nowSeconds() + 60, "b-old"));
    let aRuns = 0;
    let bRuns = 0;
    const ca = coordinatorFor(a, slowHelper(() => (aRuns++, writeCodexAuth(a.home, fakeJwt(nowSeconds() + 3600, "a-new")))));
    const cb = coordinatorFor(b, slowHelper(() => (bRuns++, writeCodexAuth(b.home, fakeJwt(nowSeconds() + 3600, "b-new")))));

    const results = await Promise.all([...Array.from({ length: 10 }, () => ca.credential()), ...Array.from({ length: 10 }, () => cb.credential())]);
    assert.equal(aRuns, 1);
    assert.equal(bRuns, 1);
    assert.equal(maxRunning, 2, "different accounts renew in parallel");
    assert.equal(new Set(results.slice(0, 10).map((c) => c.revision)).size, 1);
    assert.notEqual(results[0]!.revision, results[10]!.revision);
  });

  test("helper completion with an unchanged credential is a failure with bounded backoff", async () => {
    captureLogs();
    let clock = Date.now();
    let runs = 0;
    const account = codexAccount("unchanged", "unused");
    writeCodexAuth(account.home, fakeJwt(Math.floor(clock / 1000) - 10, "expired"));
    const coordinator = coordinatorFor(account, async () => (runs++, { outcome: "completed" }), () => clock);

    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "unavailable");
    assert.match(coordinator.status().lastError ?? "", /unchanged/);
    for (let i = 0; i < 5; i++) await assert.rejects(coordinator.credential());
    assert.equal(runs, 1, "no helper reruns during backoff");
    assert.ok(coordinator.status().retryAfter);

    clock += 31_000;
    await assert.rejects(coordinator.credential());
    assert.equal(runs, 2, "retries after backoff elapses");
  });

  test("a due but unexpired credential stays usable when renewal fails", async () => {
    captureLogs();
    const account = codexAccount("due", "unused");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 60, "due"));
    const coordinator = coordinatorFor(account, async (): Promise<HelperOutcome> => ({ outcome: "failed", detail: "synthetic" }));
    const credential = await coordinator.credential();
    assert.ok(credential.accessToken);
    assert.equal(coordinator.status().state, "ready");
    assert.equal(coordinator.status().lastError, "synthetic");
  });

  test("expired credential without a helper reports login required", async () => {
    const account: AccountConfig = { id: "nohelper", provider: "claude", home: tempDir() };
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "login_required");
  });

  test("unenrolled account reports not_enrolled", async () => {
    const coordinator = coordinatorFor({ id: "empty", provider: "codex", home: tempDir() });
    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "not_enrolled");
  });

  test("401 recovery reuses an externally replaced credential before running a helper", async () => {
    const account = codexAccount("replaced", "unused");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 3600, "v1"));
    let runs = 0;
    const coordinator = coordinatorFor(account, async () => (runs++, { outcome: "completed" }));
    const v1 = await coordinator.credential();
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 3600, "v2"));
    const recovered = await coordinator.recoverFromUnauthorized(v1);
    assert.ok(recovered && recovered.revision !== v1.revision);
    assert.equal(runs, 0);
  });
});

describe("codex app-server helper", () => {
  test("initialize, initialized, account/read{refreshToken} renews and the reread credential is accepted", async () => {
    captureLogs();
    const account = codexAccount("codex-renew", "renew");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const coordinator = coordinatorFor(account);
    const before = await credentialReaderFor("codex", account.home)();
    const credential = await coordinator.credential();
    assert.ok(before.status === "ok");
    assert.notEqual(credential.revision, before.credential.revision);
    assert.ok((credential.expiresAt ?? 0) > Date.now() + 3000_000);
    assert.equal(coordinator.status().state, "ready");
    assert.ok(coordinator.status().lastRenewedAt);

    const methods = rpcLog(account.home).filter((entry) => "method" in entry || "id" in entry).map((entry) => entry.method);
    assert.deepEqual(methods, ["initialize", "initialized", "account/read"]);
    const read = rpcLog(account.home).find((entry) => entry.method === "account/read");
    assert.deepEqual(read?.params, { refreshToken: true });

    // Restart: a new coordinator reads the persisted credential without renewing.
    const restarted = coordinatorFor(account);
    assert.equal((await restarted.credential()).revision, credential.revision);
    assert.equal(restarted.status().helperRuns, 0);
  });

  test("helper environment excludes gateway overrides and runs in the neutral directory", async () => {
    const env = helperEnv("codex", "/profiles/x", {
      PATH: "/bin",
      HOME: "/home/u",
      OPENAI_BASE_URL: "http://127.0.0.1:8417/codex",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8417/claude",
      ANTHROPIC_AUTH_TOKEN: "aar_x",
      CODEX_HOME: "/home/u/.codex",
      AAR_TOKEN: "aar_y",
    });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u", CODEX_HOME: "/profiles/x" });

    captureLogs();
    const account = codexAccount("codex-env", "renew");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const workDir = tempDir("aar-cwd-");
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1/claude";
    try {
      const outcome = await helperFor(account.helper!)({ account, workDir });
      assert.equal(outcome.outcome, "completed");
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
    const first = rpcLog(account.home)[0] as { env: string[]; cwd: string };
    assert.ok(!first.env.includes("ANTHROPIC_BASE_URL"));
    assert.ok(first.env.includes("CODEX_HOME"));
    assert.ok(first.cwd.endsWith(workDir.split("/").pop()!));
  });

  test("logged-out profile maps to login_required", async () => {
    captureLogs();
    const account = codexAccount("codex-logged-out", "logged-out");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() - 10, "old"));
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "login_required");
  });

  test("server-initiated requests are declined instead of hanging", async () => {
    captureLogs();
    const account = codexAccount("codex-server-request", "server-request");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const outcome = await helperFor(account.helper!)({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "completed");
    assert.ok(rpcLog(account.home).some((entry) => entry.id === 900 && entry.error === true));
  });

  test("a hanging app-server is terminated at its deadline", async () => {
    const account = codexAccount("codex-hang", "hang", { timeoutSeconds: 1 });
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const started = Date.now();
    const outcome = await helperFor(account.helper!)({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "failed");
    assert.ok(Date.now() - started < 5000);
  });

  test("profile config that overrides the provider endpoint refuses to run the helper", async () => {
    const account = codexAccount("codex-override", "renew");
    writeFileSync(join(account.home, "config.toml"), 'model_provider = "aar"\n[model_providers.aar]\nbase_url = "http://127.0.0.1:8417/codex"\n');
    const outcome = await helperFor(account.helper!)({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "failed");
    assert.ok(!existsSync(join(account.home, "rpc-log.jsonl")), "helper never started");
  });

  test("claude settings env overrides are detected", async () => {
    const account = claudeAccount("claude-override", "renew");
    writeFileSync(join(account.home, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8417/claude" } }));
    assert.match((await directProviderProblem({ account, workDir: "/" })) ?? "", /ANTHROPIC_BASE_URL/);
  });
});

describe("command helper", () => {
  test("renew mode replaces the Claude credential and is verified by reread", async () => {
    captureLogs();
    const account = claudeAccount("claude-renew", "renew");
    writeClaudeCredentials(account.home, "old", Date.now() + 1000);
    const credential = await coordinatorFor(account).credential();
    assert.match(credential.accessToken, /^renewed-/);
  });

  test("a successful exit without persistence is not treated as renewal", async () => {
    const logs = captureLogs();
    const account = claudeAccount("claude-unchanged", "unchanged");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential());
    assert.match(coordinator.status().lastError ?? "", /unchanged/);
    assert.ok(logs.some((line) => line.includes('"helper.failed"')));
  });

  test("helper stderr secrets do not reach logs", async () => {
    const logs = captureLogs();
    const account = claudeAccount("claude-fail", "fail");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential());
    assert.ok(logs.length > 0);
    assert.ok(!logs.join("\n").includes("SECRET-LEAK"));
    assert.ok(!(coordinator.status().lastError ?? "").includes("SECRET-LEAK"));
  });

  test("timeout terminates the helper and its descendants", async () => {
    captureLogs();
    const account = claudeAccount("claude-hang", "hang-with-child", 1);
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const started = Date.now();
    const outcome = await helperFor(account.helper!)({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "failed");
    assert.match((outcome as { detail: string }).detail, /timed out/);
    assert.ok(Date.now() - started < 5000);
    const childPid = Number(readFileSync(join(account.home, "child.pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(childPid, 0), "descendant process was terminated");
  });
});
