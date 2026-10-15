import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { COST_ESTIMATED_CACHE, HistoryStore } from "../src/history.ts";
import { Metrics } from "../src/metrics.ts";
import { zeroUsage, type UsageFigures } from "../src/usage.ts";
import { captureLogs, tempDir } from "./support.ts";

const usage = (values: Partial<UsageFigures>): UsageFigures => ({ ...zeroUsage(), ...values });

describe("metrics", () => {
  test("every event adds into each tier; only complete buckets are reported", () => {
    let now = 1_000_000_000_000;
    const metrics = new Metrics({ now: () => now });
    const handle = metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "work", client: "laptop", poolId: "11111111-1111-4111-8111-111111111111", tapped: true });
    handle.bytesUp(1000);
    handle.usage(usage({ input: 10, cacheRead: 90 }), false, false);
    now += 1000;
    handle.usage(usage({ output: 25 }), true, false);
    now += 1000;
    handle.usage(usage({ output: -5 }), false, true);
    handle.end(200);
    now += 1000;
    const second = metrics.history("2m", "account:work", ["input", "cacheRead", "output", "requests"]);
    assert.equal(second.completeThrough, Math.floor(now / 1000) - 1);
    assert.deepEqual(second.series.output!.slice(-3), [0, 25, -5]);
    assert.deepEqual(second.series.input!.slice(-3), [10, 0, 0]);
    assert.equal(second.series.requests!.at(-3), 1);
    // The 10-second tier holds the same sums in fewer buckets.
    now += 10_000;
    const tens = metrics.history("10m", "pool:11111111-1111-4111-8111-111111111111", ["output"]);
    assert.equal(tens.series.output!.reduce((a, b) => a! + (b ?? 0), 0), 20);
    // Buckets before this scope existed are gaps, not zeros.
    assert.equal(metrics.history("2m", "all", ["requests"]).series.requests![0], null);
    // Appends return only buckets completed after the caller's position.
    const after = metrics.history("2m", "all", ["requests"], second.completeThrough);
    assert.equal(after.start, second.completeThrough + 1);
    assert.equal(after.series.requests!.length, after.completeThrough - second.completeThrough);
    const entry = metrics.recentRequests()[0]!;
    assert.equal(entry.outcome, "ok");
    assert.deepEqual(entry.usage, usage({ input: 10, cacheRead: 90, output: 20 }));
    assert.equal(entry.estimated, false);
    assert.equal(entry.bytesUp, 1000);
  });

  test("active streams, errors, unreported usage and live rates", () => {
    let now = 2_000_000_000_000;
    const metrics = new Metrics({ now: () => now });
    const events: string[] = [];
    metrics.onEvent((event) => events.push(`${event.entry.id}:${event.entry.outcome}`));
    const a = metrics.begin({ provider: "codex", route: "/responses", accountId: "a", client: "c", tapped: true });
    const b = metrics.begin({ provider: "codex", route: "/responses", accountId: "a", client: "c", tapped: true });
    a.usage(usage({ output: 50 }), true, false);
    assert.equal(metrics.snapshot().scopes["account:a"]!.active, 2);
    a.end(200, "client_closed");
    b.end(429);
    now += 1000;
    const live = metrics.snapshot().scopes["account:a"]!;
    assert.equal(live.active, 0);
    assert.equal(live.minute.errors, 1);
    assert.equal(live.minute.unreported, 1, "a 2xx without a final provider figure");
    assert.equal(live.rate.output, 10);
    assert.deepEqual(events, ["1:active", "2:active", "1:client_closed", "2:error"]);
    assert.equal(metrics.recentRequests()[1]!.estimated, true);
    assert.deepEqual(metrics.recentRequests(1).map((e) => e.id), [2]);
  });

  test("account activity sums the chosen series per second per complete bucket, for every account", () => {
    let now = 2_100_000_000_000;
    const metrics = new Metrics({ now: () => now });
    const handle = metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "a", client: "c", tapped: true });
    handle.usage(usage({ input: 10, cacheRead: 3000, cacheWrite: 90, output: 900 }), false, true);
    handle.end(200);
    metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "b", client: "c", tapped: true }).end(200);
    now += 10_000;
    const minute = metrics.activity("10m", ["input", "cacheRead", "cacheWrite", "output"]);
    assert.equal(minute.bucketMs, 5000);
    assert.equal(minute.accounts.a!.length, 120);
    assert.equal(minute.accounts.a!.filter((v) => v !== null && v > 0).length, 1);
    assert.equal(minute.accounts.a!.find((v) => v !== null && v > 0), 4000 / 5, "sent and output, per second of a five-second bucket");
    assert.ok(minute.accounts.b!.every((v) => v === null || v === 0), "an account with requests but no tokens is flat");
    assert.equal(minute.accounts.all, undefined, "only accounts");
    assert.equal(metrics.activity("10m", ["cacheWrite", "output"]).accounts.a!.find((v) => v !== null && v > 0), 990 / 5, "only the chosen series");
  });

  test("active sessions count each client session once per scope, for a minute after its last request", () => {
    let now = 2_000_000_000_000;
    const metrics = new Metrics({ now: () => now });
    const start = (accountId: string, sessionId?: string) =>
      metrics.begin({ provider: "claude", route: "/v1/messages", accountId, client: "c", sessionId, tapped: true });
    // Two requests of one session in parallel, as subagents run, count once.
    const parent = start("a", "s-1"), subagent = start("a", "s-1");
    const other = start("b", "s-2");
    start("b");
    assert.equal(metrics.snapshot().scopes.all!.sessions, 2, "requests without a session id are not sessions");
    assert.equal(metrics.snapshot().scopes["account:a"]!.sessions, 1);
    subagent.end(200);
    other.end(200);
    now += 61_000;
    assert.deepEqual([metrics.snapshot().scopes.all!.sessions, metrics.snapshot().scopes["account:b"]!.sessions], [1, 0],
      "a session with a request still running stays active; an idle one lapses after a minute");
    parent.end(200);
    assert.equal(metrics.snapshot().scopes.all!.sessions, 1, "the end of a request counts as activity");
    now += 61_000;
    assert.equal(metrics.snapshot().scopes.all!.sessions, 0);
  });

  test("stored tiers, quota readings and recent requests survive a restart; downtime stays a gap", () => {
    const dir = tempDir();
    const path = join(dir, "history.db");
    let now = 3_000_000_000_000;
    const store = new HistoryStore(path);
    const first = new Metrics({ history: store, now: () => now });
    const handle = first.begin({ provider: "claude", route: "/v1/messages", accountId: "work", client: "c", sessionId: "session-1", tapped: true });
    handle.usage(usage({ cacheRead: 5000 }), false, true);
    handle.end(200);
    first.quota("work", [{ bucket: "five_hour", windowMinutes: 300, usedPercent: 42, remainingPercent: 58, resetsAt: null }]);
    now += 600_000;
    first.close();
    store.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // Two hours later the router starts again.
    now += 2 * 3_600_000;
    const reopened = new HistoryStore(path);
    const second = new Metrics({ history: reopened, now: () => now });
    const day = second.history("24h", "account:work", ["cacheRead", "quota"]);
    const values = day.series.cacheRead!;
    assert.equal(values.filter((v) => v === 5000).length, 1);
    const covered = values.map((v) => v !== null);
    const lastCovered = covered.lastIndexOf(true);
    assert.ok(lastCovered < values.length - 20, "the two hours offline are gaps");
    assert.equal(day.series["quota:five_hour"]!.filter((v) => v === 42).length, 1);
    assert.equal(second.history("2m", "account:work", ["cacheRead"]).series.cacheRead!.every((v) => v === null || v === 0), true, "short tiers are not persisted");
    assert.deepEqual(second.snapshot().quota.work?.map((w) => w.usedPercent), [42], "the last reading is kept for display");
    assert.equal(second.snapshot().quotaAt.work, 3_000_000_000_000, "with the time it was observed");
    const [restored] = second.recentRequests();
    assert.equal(restored?.sessionId, "session-1", "finished requests are listed again after a restart");
    assert.equal(restored?.usage.cacheRead, 5000);
    second.close();
    reopened.close();
  });

  test("sessions total every stored request; scope narrows which sessions qualify", () => {
    let now = 4_000_000_000_000;
    const store = new HistoryStore(join(tempDir(), "history.db"));
    const metrics = new Metrics({ history: store, now: () => now });
    const request = (accountId: string, sessionId: string | undefined, output: number, status = 200, model = "m1") => {
      const handle = metrics.begin({ provider: "claude", route: "/v1/messages", accountId, client: "laptop", sessionId, tapped: true });
      handle.model(model);
      handle.usage(usage({ cacheRead: 100, cacheWrite: 10, output }), false, true);
      now += 1000;
      handle.end(status);
    };
    request("a", "s-one", 5);
    now += 3_600_000;
    request("b", "s-one", 7, 500, "m2");
    request("a", "s-two", 11);
    request("a", undefined, 13);
    const recent = metrics.sessions(now - 600_000);
    assert.deepEqual(recent.map((s) => s.sessionId), ["s-two", "s-one"], "newest activity first; requests without a session are left out");
    const one = recent[1]!;
    assert.equal(one.requests, 2, "totals include requests from before the window");
    assert.equal(one.errors, 1);
    assert.deepEqual(one.usage, { input: 0, cacheRead: 200, cacheWrite: 20, output: 12, reasoning: 0, cacheWrite1h: 0, webSearches: 0 });
    assert.deepEqual(one.accountIds, ["b", "a"], "most recently used account first");
    assert.equal(one.model, "m2");
    assert.deepEqual(metrics.sessions(now - 600_000, { accountId: "b" }).map((s) => s.sessionId), ["s-one"]);
    assert.deepEqual(metrics.sessions(now - 600_000, { poolId: "11111111-1111-4111-8111-111111111111" }), []);
    metrics.close();
    store.close();
  });

  test("a version 1 database gains the pricing columns, and stored history is priced at startup", () => {
    const path = join(tempDir(), "history.db");
    // The version 1 requests table, as the first history.db release created it.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE requests (request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, client TEXT NOT NULL,
        account_id TEXT NOT NULL, provider TEXT NOT NULL, pool_id TEXT, binding_id TEXT, session_id TEXT, route TEXT NOT NULL, model TEXT,
        status INTEGER, outcome TEXT NOT NULL, bytes_up INTEGER NOT NULL, bytes_down INTEGER NOT NULL, input INTEGER NOT NULL,
        cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, estimated INTEGER NOT NULL);
      INSERT INTO meta VALUES ('schema', '1');`);
    const now = Date.parse("2026-10-15T12:00:00Z");
    old.prepare(`INSERT INTO requests VALUES ('old', ?, ?, 'c', 'a', 'claude', NULL, NULL, 's', '/v1/messages', 'claude-opus-5-5', 200, 'ok', 0, 0,
      1000, 100000, 2000, 500, 0, 0)`).run(now - 60_000, now - 59_000);
    old.close();
    chmodSync(path, 0o600);
    const store = new HistoryStore(path);
    const metrics = new Metrics({ history: store, now: () => now });
    const [restored] = metrics.recentRequests();
    // Written before the split was recorded: cache writes at the five-minute rate, marked estimated.
    assert.ok(Math.abs(restored!.cost! - (1000 * 4 + 100_000 * 0.2 + 2000 * 5 + 500 * 20) / 1e6) < 1e-12);
    assert.equal(restored!.costFlags, COST_ESTIMATED_CACHE);
    const handle = metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "a", client: "c", sessionId: "s", tapped: true });
    handle.model("claude-opus-5-5");
    handle.attributes({ cacheSplit: true });
    handle.usage(usage({ cacheWrite: 1000, cacheWrite1h: 1000, output: 100 }), false, true);
    handle.end(200);
    const fresh = metrics.recentRequests()[0]!;
    assert.ok(Math.abs(fresh.cost! - (1000 * 8 + 100 * 20) / 1e6) < 1e-12, "one-hour writes at the one-hour rate");
    assert.equal(fresh.costFlags, 0);
    const summary = metrics.costSummary(now - 120_000)!;
    assert.deepEqual({ ...summary, cost: Math.round(summary.cost * 1e6), high: Math.round(summary.high * 1e6) },
      { cost: 44_000 + 10_000, high: 44_000 + 2000 * 3 + 10_000, requests: 2, unpriced: 0, estimated: 1 });
    assert.equal(metrics.sessions(now - 120_000)[0]!.cost.requests, 2);
    const unknown = metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "a", client: "c", tapped: true });
    unknown.model("claude-unreleased");
    unknown.usage(usage({ output: 5 }), false, true);
    unknown.end(200);
    assert.equal(metrics.costSummary(now - 120_000)!.unpriced, 1, "unpriced, not free");
    metrics.close();
    store.close();
    // Reopening with the same price table does not reprice.
    const logs = captureLogs();
    const again = new Metrics({ history: new HistoryStore(path), now: () => now });
    assert.equal(logs.join("\n").includes("history.repriced"), false);
    again.close();
  });

  test("retention deletes old history and is bounded; without a store nothing is kept", () => {
    let now = 5_000_000_000_000;
    const store = new HistoryStore(join(tempDir(), "history.db"));
    const metrics = new Metrics({ history: store, now: () => now });
    const pruned: number[] = [];
    metrics.onPrune = (days) => pruned.push(days);
    assert.equal(metrics.retentionDays(), 30, "30 days by default");
    const handle = metrics.begin({ provider: "claude", route: "/v1/messages", accountId: "a", client: "c", sessionId: "old", tapped: true });
    handle.usage(usage({ output: 1 }), false, true);
    handle.end(200);
    metrics.save();
    now += 10 * 86_400_000;
    metrics.setRetentionDays(30);
    assert.equal(store.recentRequests(10).length, 1, "within retention");
    metrics.setRetentionDays(7);
    assert.deepEqual(pruned, [30, 7]);
    assert.equal(store.recentRequests(10).length, 0, "older than the new retention");
    assert.equal(store.buckets("30d", 0).length, 0);
    assert.throws(() => metrics.setRetentionDays(0), RangeError);
    assert.throws(() => metrics.setRetentionDays(1.5), RangeError);
    metrics.close();
    store.close();
    const memory = new Metrics();
    assert.equal(memory.retentionDays(), null);
    assert.deepEqual(memory.sessions(0), []);
  });

  test("an unreadable or exposed history database is refused, not overwritten", () => {
    const dir = tempDir();
    const corrupt = join(dir, "corrupt.db");
    writeFileSync(corrupt, "not a database", { mode: 0o600 });
    assert.throws(() => new HistoryStore(corrupt));
    assert.equal(readFileSync(corrupt, "utf8"), "not a database");
    if (process.platform !== "win32") {
      const exposed = join(dir, "exposed.db");
      new HistoryStore(exposed).close();
      chmodSync(exposed, 0o644);
      assert.throws(() => new HistoryStore(exposed), /insecure/);
    }
  });
});
