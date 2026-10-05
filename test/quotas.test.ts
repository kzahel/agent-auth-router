import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fetchAccountQuotas, normalizeClaudeQuotas, normalizeCodexQuotas } from "../src/quotas.ts";
import type { AccountConfig } from "../src/types.ts";
import { FIXTURES, mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

function profile(provider: "claude" | "codex"): AccountConfig {
  return { id: `synthetic-${provider}`, provider, home: tempDir() };
}
const fakeCodex = (mode = "ok", timeoutMs = 2000) => ({ codexCommand: process.execPath,
  codexArgs: [join(FIXTURES, "fake-codex-quotas.ts"), mode], timeoutMs });

test("Codex normalization supports multiple and legacy buckets, seconds, zero and unknown values", () => {
  assert.deepEqual(normalizeCodexQuotas({ rateLimits: { limitId: "codex", primary: {
    usedPercent: 0, windowDurationMins: 300, resetsAt: 1791000000,
  }, secondary: { usedPercent: null, windowDurationMins: null, resetsAt: null } } }), [
    { bucket: "codex:primary", windowMinutes: 300, usedPercent: 0, remainingPercent: 100, resetsAt: new Date(1791000000000).toISOString() },
    { bucket: "codex:secondary", windowMinutes: null, usedPercent: null, remainingPercent: null, resetsAt: null },
  ]);
  assert.deepEqual(normalizeCodexQuotas({ rateLimitsByLimitId: { "bad/email@example.com": { primary: { usedPercent: 1 } } } }), []);
});

test("Claude usage percentages are not header fractions; absent buckets and invalid values stay unknown", () => {
  assert.deepEqual(normalizeClaudeQuotas({ five_hour: { utilization: 0.5, resets_at: "2026-10-03T05:00:00Z" },
    seven_day: { utilization: 104, resets_at: null }, seven_day_opus: null,
    seven_day_sonnet: { utilization: "20", resets_at: "invalid" },
    extra_usage: { secret: "SECRET" }, email: "SECRET-email" }), [
    { bucket: "five_hour", windowMinutes: 300, usedPercent: 0.5, remainingPercent: 99.5, resetsAt: "2026-10-03T05:00:00.000Z" },
    { bucket: "seven_day", windowMinutes: 10080, usedPercent: 104, remainingPercent: 0, resetsAt: null },
    { bucket: "seven_day_sonnet", windowMinutes: 10080, usedPercent: null, remainingPercent: null, resetsAt: null },
  ]);
  assert.deepEqual(normalizeClaudeQuotas(null), []);
});

test("Claude paid overage credits are not a quota window, whether disabled or in use", () => {
  const five = { utilization: 0, resets_at: null };
  for (const extra of [{ is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    { is_enabled: true, monthly_limit: 5000, used_credits: 2500, utilization: 50 }])
    assert.deepEqual(normalizeClaudeQuotas({ five_hour: five, extra_usage: extra }).map(w => w.bucket), ["five_hour"]);
  assert.deepEqual(normalizeClaudeQuotas({ five_hour: five, seven_day_future: { utilization: null } }).map(w => w.bucket),
    ["five_hour", "seven_day_future"], "other unrecognized buckets stay visible and block as unknown scope");
});

test("Codex quota reader uses isolated official protocol without forced refresh or inference", async () => {
  const account = profile("codex");
  const cwd = tempDir();
  const snapshot = await fetchAccountQuotas(account, cwd, { ...fakeCodex(), env: { ...process.env,
    OPENAI_BASE_URL: "SECRET-base", OPENAI_API_KEY: "SECRET-key", CLAUDE_CONFIG_DIR: "SECRET-home", ANTHROPIC_AUTH_TOKEN: "SECRET-token" } });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[2]!.remainingPercent, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
  assert.deepEqual(JSON.parse(readFileSync(join(account.home, "process.json"), "utf8")), { cwd: realpathSync(cwd), home: account.home });
  const requests = readFileSync(join(account.home, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "account/rateLimits/read"]);
});

test("Codex reader declines server token requests and continues quota RPC", async () => {
  const account = profile("codex");
  const snapshot = await fetchAccountQuotas(account, tempDir(), fakeCodex("server-request"));
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.windows[0]!.usedPercent, 50);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test("Codex reader bounds timeout, output and malformed protocol without leaking errors", async () => {
  for (const mode of ["hang", "oversized", "malformed", "error"]) {
    const snapshot = await fetchAccountQuotas(profile("codex"), tempDir(), fakeCodex(mode, mode === "hang" ? 300 : 2000));
    assert.equal(snapshot.status, "unavailable", mode);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/, mode);
    assert.deepEqual(snapshot.windows, []);
  }
});

test("Codex quota reader refuses endpoint overrides before spawning", async () => {
  const account = profile("codex");
  writeFileSync(join(account.home, "config.toml"), 'model_provider = "router"\n');
  const snapshot = await fetchAccountQuotas(account, tempDir(), fakeCodex());
  assert.equal(snapshot.error, "profile overrides the provider endpoint");
  assert.throws(() => readFileSync(join(account.home, "process.json")));
});

test("Claude usage reads only the selected profile's current access token and quota path", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access-1", Date.now() + 100000);
  const upstream = await mockUpstream((_req, res) => res.end(JSON.stringify({ five_hour: { utilization: 20, resets_at: null },
    seven_day: { utilization: 45, resets_at: "2026-10-10T00:00:00Z" }, token: "SECRET-body", email: "SECRET-email" })));
  for (const token of ["SECRET-access-1", "SECRET-access-2"]) {
    writeClaudeCredentials(account.home, token, Date.now() + 100000);
    const snapshot = await fetchAccountQuotas(account, tempDir(), { claudeOrigin: upstream.origin });
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.windows[0]!.remainingPercent, 80);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
    const request = upstream.requests.at(-1)!;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/oauth/usage");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(request.body, "");
  }
});

test("Claude quota reader refuses redirects and never forwards credentials to redirect targets", async () => {
  const target = await mockUpstream((_req, res) => res.end("SECRET-target"));
  const upstream = await mockUpstream((_req, res) => { res.writeHead(302, { location: target.origin }); res.end("SECRET-body"); });
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  const snapshot = await fetchAccountQuotas(account, tempDir(), { claudeOrigin: upstream.origin });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(target.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test("Claude auth failures and repeated throttles are sanitized and never retried", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  for (const code of [401, 403, 429, 429]) {
    const upstream = await mockUpstream((_req, res) => { res.writeHead(code, { "retry-after": "42" }); res.end("SECRET-provider-body"); });
    const snapshot = await fetchAccountQuotas(account, tempDir(), { claudeOrigin: upstream.origin });
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.retryAfterSeconds, 42);
    assert.equal(upstream.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
  }
});

test("Claude quota reader bounds stalled, oversized, malformed and unrecognized responses", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  for (const mode of ["hang", "oversized", "malformed", "unknown"]) {
    const upstream = await mockUpstream((_req, res) => {
      if (mode === "hang") { res.writeHead(200); res.write("{"); return; }
      res.end(mode === "oversized" ? "x".repeat(300 * 1024) : mode === "malformed" ? "SECRET-invalid" : '{"secret":"SECRET"}');
    });
    const snapshot = await fetchAccountQuotas(account, tempDir(), { claudeOrigin: upstream.origin, timeoutMs: 150 });
    assert.equal(snapshot.status, "unavailable", mode);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/, mode);
  }
});

test("Disabled and unsigned-in profiles make no quota requests", async () => {
  const upstream = await mockUpstream((_req, res) => res.end("SECRET"));
  const account = profile("claude");
  assert.equal((await fetchAccountQuotas(account, tempDir(), { claudeOrigin: upstream.origin })).status, "unavailable");
  assert.equal((await fetchAccountQuotas({ ...account, enabled: false }, tempDir(), { claudeOrigin: upstream.origin })).error, "account disabled");
  assert.equal(upstream.requests.length, 0);
});


test("unknown Claude quota windows retain evidence instead of disappearing", () => {
  assert.deepEqual(normalizeClaudeQuotas({ new_model_window: { utilization: 100, resets_at: "2026-10-10T00:00:00Z" } }), [
    { bucket: "new_model_window", windowMinutes: null, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-10-10T00:00:00.000Z" },
  ]);
});
