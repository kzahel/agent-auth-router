import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fetchAccountQuotas, normalizeClaudeQuotas, readAccountQuotas, normalizeCodexQuotas, normalizeResponseHeaderQuotas } from "../src/quotas.ts";
import type { AccountConfig } from "../src/types.ts";
import { FIXTURES, tempDir, writeClaudeCredentials } from "./support.ts";

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

const fakeClaude = (mode = "ok", timeoutMs = 5000) => ({ claudeCommand: process.execPath,
  claudeArgs: [join(FIXTURES, "fake-claude-cli.ts"), mode], timeoutMs });
const cliStarts = (home: string) => {
  try { return readFileSync(join(home, "cli-log.jsonl"), "utf8").trim().split("\n").filter(line => JSON.parse(line).event === "start").length; }
  catch { return 0; }
};

test("Claude usage comes from an isolated official CLI session without a prompt", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  const snapshot = await fetchAccountQuotas(account, tempDir(), { ...fakeClaude(), env: { ...process.env,
    ANTHROPIC_BASE_URL: "SECRET-base", ANTHROPIC_AUTH_TOKEN: "SECRET-token" } });
  assert.equal(snapshot.status, "ok");
  assert.deepEqual(snapshot.windows.map(w => [w.bucket, w.remainingPercent]), [["five_hour", 80], ["seven_day", 55]],
    "null buckets and paid overage are not windows");
  assert.ok(Date.parse(snapshot.windows[0]!.resetsAt!) > Date.now(), "offset reset times normalize to ISO");
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
  const log = readFileSync(join(account.home, "cli-log.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(!log[0].env.includes("ANTHROPIC_BASE_URL") && !log[0].env.includes("ANTHROPIC_AUTH_TOKEN"));
  assert.deepEqual(log.filter(entry => entry.event === "message").map(entry => entry.subtype), ["initialize", "get_usage"]);
});

test("an expired Claude access token is renewed by the CLI while reading usage", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-expired", Date.now() - 1000);
  const snapshot = await fetchAccountQuotas(account, tempDir(), fakeClaude("renew"));
  assert.equal(snapshot.status, "ok");
  assert.match(readFileSync(join(account.home, ".credentials.json"), "utf8"), /renewed-/);
});

test("Claude CLI usage failures are bounded and sanitized", async () => {
  for (const mode of ["logged-out", "no-usage", "reject-usage", "oversized", "hang"]) {
    const account = profile("claude");
    writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
    const snapshot = await fetchAccountQuotas(account, tempDir(), fakeClaude(mode, mode === "hang" ? 500 : 5000));
    assert.equal(snapshot.status, "unavailable", mode);
    assert.deepEqual(snapshot.windows, [], mode);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/, mode);
  }
});

test("the Claude usage read also returns the CLI's own model rows, bounded", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  const read = await readAccountQuotas(account, tempDir(), fakeClaude());
  assert.equal(read.status, "ok");
  assert.deepEqual(read.cliModels?.map(m => [m.value, m.resolvedModel ?? null]), [
    ["default", "claude-opus-fixture-2"], ["sonnet", "claude-sonnet-fixture-2"], ["haiku", "claude-haiku-fixture-1"], ["opusplan", null]]);
  assert.equal(read.cliModels?.[1]?.description, "Sonnet Fixture 2 for everyday tasks");
  assert.deepEqual(read.cliModels?.[1]?.supportedEffortLevels, ["low", "medium", "high", "max"]);
  assert.equal("cliModels" in await fetchAccountQuotas(account, tempDir(), fakeClaude()), false, "quota snapshots stay quota-only");

  for (const mode of ["no-usage", "reject-usage"]) {
    const failed = await readAccountQuotas(account, tempDir(), fakeClaude(mode));
    assert.equal(failed.status, "unavailable", mode);
    assert.equal(failed.cliModels?.length, 4, `${mode}: rows survive a failed usage read`);
  }
  assert.equal((await readAccountQuotas(account, tempDir(), fakeClaude("logged-out"))).cliModels, undefined, "a signed-out CLI's rows are not the account's");

  const odd = await readAccountQuotas(account, tempDir(), fakeClaude("odd-models"));
  assert.equal(odd.cliModels?.length, 61, "64-row bound applied before malformed rows are dropped");
  assert.ok(odd.cliModels!.every(m => m.displayName.length <= 200 && (m.description?.length ?? 0) <= 300 && m.value.length <= 200));
  assert.deepEqual(odd.cliModels![0]!.supportedEffortLevels, ["high"]);
  assert.doesNotMatch(JSON.stringify(odd), /SECRET/);
});

test("Claude quota reader refuses endpoint overrides before spawning", async () => {
  const account = profile("claude");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  writeFileSync(join(account.home, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }));
  const snapshot = await fetchAccountQuotas(account, tempDir(), fakeClaude());
  assert.match(snapshot.error ?? "", /ANTHROPIC_BASE_URL/);
  assert.equal(cliStarts(account.home), 0);
});

test("Disabled and signed-out profiles never start a quota process", async () => {
  const account = profile("claude");
  assert.equal((await fetchAccountQuotas(account, tempDir(), fakeClaude())).status, "unavailable");
  writeClaudeCredentials(account.home, "SECRET-access", Date.now() + 100000);
  assert.equal((await fetchAccountQuotas({ ...account, enabled: false }, tempDir(), fakeClaude())).error, "account disabled");
  assert.equal(cliStarts(account.home), 0);
});


test("unknown Claude quota windows retain evidence instead of disappearing", () => {
  assert.deepEqual(normalizeClaudeQuotas({ new_model_window: { utilization: 100, resets_at: "2026-10-10T00:00:00Z" } }), [
    { bucket: "new_model_window", windowMinutes: null, usedPercent: 100, remainingPercent: 0, resetsAt: "2026-10-10T00:00:00.000Z" },
  ]);
});

test("response headers yield shared windows: Claude fractions and epoch resets, Codex percentages and relative resets", () => {
  const now = Date.parse("2026-10-05T13:47:34Z");
  assert.deepEqual(normalizeResponseHeaderQuotas("claude", {
    "anthropic-ratelimit-unified-5h-utilization": "0.02", "anthropic-ratelimit-unified-5h-reset": "1791214800",
    "anthropic-ratelimit-unified-7d-utilization": ["0.0", "1.0"], "anthropic-ratelimit-unified-7d-reset": "not-a-time",
    "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-overage-utilization": "0.9", "set-cookie": "SECRET",
  }, now), [
    { bucket: "five_hour", windowMinutes: 300, usedPercent: 2, remainingPercent: 98, resetsAt: "2026-10-05T15:40:00.000Z" },
    { bucket: "seven_day", windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: null },
  ]);
  // Absent, oversized, control-character and non-numeric values report nothing rather than a guess.
  assert.deepEqual(normalizeResponseHeaderQuotas("claude", { "anthropic-ratelimit-unified-5h-utilization": "0.5\r\nx: y" }, now), []);
  assert.deepEqual(normalizeResponseHeaderQuotas("claude", { "anthropic-ratelimit-unified-5h-utilization": "1e3" }, now), []);
  assert.deepEqual(normalizeResponseHeaderQuotas("claude", { "x-codex-primary-used-percent": "40" }, now), []);
  assert.deepEqual(normalizeResponseHeaderQuotas("codex", {
    "x-codex-primary-used-percent": "40", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "90",
    "x-codex-secondary-used-percent": "12.5", "x-codex-secondary-reset-at": "1791579600",
    "x-codex-additional-bengalfox-primary-used-percent": "99",
  }, now), [
    { bucket: "codex:primary", windowMinutes: 300, usedPercent: 40, remainingPercent: 60, resetsAt: "2026-10-05T13:49:04.000Z" },
    { bucket: "codex:secondary", windowMinutes: null, usedPercent: 12.5, remainingPercent: 87.5, resetsAt: "2026-10-09T21:00:00.000Z" },
  ]);
});
