import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CredentialCoordinator, CredentialUnavailable } from "../src/coordinator.ts";
import { credentialReaderFor } from "../src/credentials.ts";
import { accountHelper, CLAUDE_CLI_ARGS, directProviderProblem, helperFor, probeClaudeCli, type HelperOutcome, type RenewalHelper } from "../src/helpers.ts";
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
    helper: helper ?? accountHelper(account),
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
    const account: AccountConfig = { id: "nohelper", provider: "claude", home: tempDir(), helper: { kind: "none" } };
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
  test("cached account read then forced refresh renews and the reread credential is accepted", async () => {
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
    assert.deepEqual(methods, ["initialize", "initialized", "account/read", "account/read"]);
    const reads = rpcLog(account.home).filter((entry) => entry.method === "account/read");
    assert.deepEqual(reads.map((entry) => entry.params), [{ refreshToken: false }, { refreshToken: true }]);

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
      const outcome = await helperFor(account.helper!)!({ account, workDir });
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
    const reads = rpcLog(account.home).filter((entry) => entry.method === "account/read");
    assert.deepEqual(reads.map((entry) => entry.params), [{ refreshToken: false }]);
  });

  test("null account after refresh is unavailable with backoff, not evidence of a missing login", async () => {
    captureLogs();
    const account = codexAccount("codex-refresh-failed", "refresh-failed");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() - 10, "old"));
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "unavailable");
    assert.equal(coordinator.status().state, "unavailable");
    assert.match(coordinator.status().lastError ?? "", /no account after refresh/);
    assert.ok(coordinator.status().retryAfter);
    await assert.rejects(coordinator.credential());
    assert.equal(coordinator.status().helperRuns, 1);
  });

  test("failed refresh leaves a due but unexpired credential usable", async () => {
    captureLogs();
    const account = codexAccount("codex-refresh-fallback", "refresh-failed");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const before = await credentialReaderFor("codex", account.home)();
    const coordinator = coordinatorFor(account);
    const credential = await coordinator.credential();
    assert.ok(before.status === "ok");
    assert.equal(credential.revision, before.credential.revision);
    assert.equal(coordinator.status().state, "ready");
    assert.ok(coordinator.status().retryAfter);
    assert.equal((await coordinator.credential()).revision, credential.revision);
    assert.equal(coordinator.status().helperRuns, 1);
  });

  test("server-initiated requests are declined instead of hanging", async () => {
    captureLogs();
    const account = codexAccount("codex-server-request", "server-request");
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const outcome = await helperFor(account.helper!)!({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "completed");
    assert.ok(rpcLog(account.home).some((entry) => entry.id === 900 && entry.error === true));
  });

  test("a hanging app-server is terminated at its deadline", async () => {
    const account = codexAccount("codex-hang", "hang", { timeoutSeconds: 1 });
    writeCodexAuth(account.home, fakeJwt(nowSeconds() + 30, "old"));
    const started = Date.now();
    const outcome = await helperFor(account.helper!)!({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "failed");
    assert.ok(Date.now() - started < 5000);
  });

  test("profile config that overrides the provider endpoint refuses to run the helper", async () => {
    const account = codexAccount("codex-override", "renew");
    writeFileSync(join(account.home, "config.toml"), 'model_provider = "aar"\n[model_providers.aar]\nbase_url = "http://127.0.0.1:8417/codex"\n');
    const outcome = await helperFor(account.helper!)!({ account, workDir: tempDir() });
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
    const outcome = await helperFor(account.helper!)!({ account, workDir: tempDir() });
    assert.equal(outcome.outcome, "failed");
    assert.match((outcome as { detail: string }).detail, /timed out/);
    assert.ok(Date.now() - started < 5000);
    const childPid = Number(readFileSync(join(account.home, "child.pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(childPid, 0), "descendant process was terminated");
  });
});

function claudeCliAccount(id: string, mode: string, timeoutSeconds = 10): AccountConfig {
  return {
    id,
    provider: "claude",
    home: tempDir(),
    helper: { kind: "claude-cli", command: process.execPath, args: [join(FIXTURES, "fake-claude-cli.ts"), mode, ...CLAUDE_CLI_ARGS], timeoutSeconds },
  };
}

function cliLog(home: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, "cli-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function writeClaudeWithoutRefresh(home: string, accessToken: string, expiresAt: number): void {
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }));
}

describe("claude-cli helper", () => {
  test("Claude accounts default to the CLI helper; explicit none opts out", () => {
    assert.ok(accountHelper({ id: "c", provider: "claude", home: "/p" }));
    assert.equal(accountHelper({ id: "c", provider: "claude", home: "/p", helper: { kind: "none" } }), undefined);
    assert.equal(accountHelper({ id: "x", provider: "codex", home: "/p" }), undefined);
  });

  test("an expired access token is renewed by an isolated no-prompt CLI session and verified by reread", async () => {
    captureLogs();
    const account = claudeCliAccount("cli-renew", "renew");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const workDir = tempDir("aar-cwd-");
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1/claude";
    process.env.ANTHROPIC_AUTH_TOKEN = "aar_gateway";
    let credential;
    try {
      credential = await new CredentialCoordinator({
        account, read: credentialReaderFor("claude", account.home), helper: accountHelper(account), helperContext: { workDir },
      }).credential();
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    assert.match(credential.accessToken, /^renewed-/);
    const [start] = cliLog(account.home) as [{ argv: string[]; cwd: string; env: string[] }];
    assert.deepEqual(start.argv, [...CLAUDE_CLI_ARGS]);
    for (const flag of ["--input-format", "--no-session-persistence", "--strict-mcp-config", "--setting-sources=", "--tools"]) assert.ok(CLAUDE_CLI_ARGS.includes(flag), flag);
    assert.ok(start.env.includes("CLAUDE_CONFIG_DIR"));
    assert.ok(!start.env.includes("ANTHROPIC_BASE_URL") && !start.env.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(start.cwd.endsWith(workDir.split("/").pop()!));
    const sent = cliLog(account.home).filter((entry) => entry.event === "message").map((entry) => entry.subtype);
    assert.deepEqual(sent, ["initialize", "get_usage"], "control requests only; no user message");
  });

  test("a profile without a saved login maps to login_required without reading usage", async () => {
    captureLogs();
    const account = claudeCliAccount("cli-logged-out", "logged-out");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential(), (error: unknown) => error instanceof CredentialUnavailable && error.state === "login_required");
    assert.equal((await coordinator.signIn()).state, "login_required");
    const sent = cliLog(account.home).filter((entry) => entry.event === "message").map((entry) => entry.subtype);
    assert.deepEqual(sent, ["initialize"]);
  });

  test("missing usage, rejected usage, non-subscription logins, oversized output and hangs fail without leaking", async () => {
    captureLogs();
    for (const mode of ["no-usage", "reject-usage", "api-key", "oversized", "hang"]) {
      const account = claudeCliAccount(`cli-${mode}`, mode, mode === "hang" ? 1 : 10);
      writeClaudeCredentials(account.home, "old", Date.now() - 1000);
      const started = Date.now();
      const outcome = await helperFor(account.helper!)!({ account, workDir: tempDir() });
      assert.equal(outcome.outcome, "failed", mode);
      assert.doesNotMatch(JSON.stringify(outcome), /SECRET/, mode);
      assert.ok(Date.now() - started < 8000, mode);
    }
  });

  test("CLI callback requests are declined instead of hanging", async () => {
    const account = claudeCliAccount("cli-callback", "callback");
    writeClaudeCredentials(account.home, "old", Date.now() + 3600_000);
    const probe = await probeClaudeCli({ account, workDir: tempDir() }, { command: process.execPath, args: [join(FIXTURES, "fake-claude-cli.ts"), "callback"] });
    assert.equal(probe.outcome, "completed");
  });

  test("concurrent probes of one profile share a single CLI process", async () => {
    const account = claudeCliAccount("cli-shared", "slow");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const options = { command: process.execPath, args: [join(FIXTURES, "fake-claude-cli.ts"), "slow"] };
    const results = await Promise.all(Array.from({ length: 5 }, () => probeClaudeCli({ account, workDir: tempDir() }, options)));
    assert.ok(results.every((result) => result.outcome === "completed"));
    assert.equal(cliLog(account.home).filter((entry) => entry.event === "start").length, 1);
  });

  test("an early unchanged result never defers renewal past the credential's expiry", async () => {
    captureLogs();
    let clock = Date.now();
    let runs = 0;
    const account = codexAccount("early-unchanged", "unused");
    writeCodexAuth(account.home, fakeJwt(Math.floor(clock / 1000) + 10, "due"));
    const coordinator = coordinatorFor(account, async () => (runs++, { outcome: "completed" }), () => clock);
    assert.ok((await coordinator.credential()).accessToken, "due credential stays usable");
    assert.equal(runs, 1);
    clock += 5_000;
    await coordinator.credential();
    assert.equal(runs, 1, "backs off while the credential is still valid");
    clock += 6_000;
    await assert.rejects(coordinator.credential());
    assert.equal(runs, 2, "an expired credential gets a renewal attempt despite the 30s backoff");
  });
});

describe("sign-in state", () => {
  test("an expired access token with a refresh token and helper is idle, not signed out", async () => {
    const account = claudeCliAccount("state-idle", "renew");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    assert.equal((await coordinator.signIn()).state, "idle");
    assert.ok(!existsSync(join(account.home, "cli-log.jsonl")), "classification itself never runs the CLI");
    captureLogs();
    await coordinator.credential();
    assert.equal((await coordinator.signIn()).state, "ready");
  });

  test("expiry without a refresh token or a helper requires sign-in; missing credentials are signed out", async () => {
    const noRefresh = claudeCliAccount("state-no-refresh", "renew");
    writeClaudeWithoutRefresh(noRefresh.home, "old", Date.now() - 1000);
    assert.equal((await coordinatorFor(noRefresh).signIn()).state, "login_required");
    const noHelper: AccountConfig = { id: "state-no-helper", provider: "claude", home: tempDir(), helper: { kind: "none" } };
    writeClaudeCredentials(noHelper.home, "old", Date.now() - 1000);
    assert.equal((await coordinatorFor(noHelper).signIn()).state, "login_required");
    const fresh = claudeCliAccount("state-ready", "renew");
    writeClaudeCredentials(fresh.home, "current", Date.now() + 3600_000);
    assert.equal((await coordinatorFor(fresh).signIn()).state, "ready");
    const codex = codexAccount("state-signed-out", "renew");
    assert.equal((await coordinatorFor(codex).signIn()).state, "signed_out");
  });

  test("a failed renewal applies only to the credential it was attempted with", async () => {
    captureLogs();
    const account = claudeCliAccount("state-failed", "no-usage");
    writeClaudeCredentials(account.home, "old", Date.now() - 1000);
    const coordinator = coordinatorFor(account);
    await assert.rejects(coordinator.credential());
    const failed = await coordinator.signIn();
    assert.equal(failed.state, "renewal_failed");
    assert.match(failed.detail ?? "", /no subscription usage/);
    writeClaudeCredentials(account.home, "signed-in-again", Date.now() + 3600_000);
    assert.equal((await coordinator.signIn()).state, "ready");
  });

  test("an upstream rejection of the current credential requires sign-in until it changes", async () => {
    captureLogs();
    const account = claudeCliAccount("state-rejected", "renew");
    writeClaudeCredentials(account.home, "rejected", Date.now() + 3600_000);
    const coordinator = coordinatorFor(account);
    coordinator.markRejected("synthetic rejection", await coordinator.credential());
    assert.equal((await coordinator.signIn()).state, "login_required");
    writeClaudeCredentials(account.home, "replacement", Date.now() + 3600_000);
    assert.equal((await coordinator.signIn()).state, "ready");
  });
});
