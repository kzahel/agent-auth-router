import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Metrics } from "../src/metrics.ts";
import { captureLogs, tempDir } from "./support.ts";

const usage = (values: Partial<Record<"input" | "cacheRead" | "cacheWrite" | "output" | "reasoning", number>>) =>
  ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...values });

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

  test("persisted tiers survive a restart with the downtime left uncovered", () => {
    const dir = tempDir();
    const path = join(dir, "metrics.json");
    let now = 3_000_000_000_000;
    const first = new Metrics({ path, now: () => now });
    const handle = first.begin({ provider: "claude", route: "/v1/messages", accountId: "work", client: "c", tapped: true });
    handle.usage(usage({ cacheRead: 5000 }), false, true);
    handle.end(200);
    first.quota("work", [{ bucket: "five_hour", windowMinutes: 300, usedPercent: 42, remainingPercent: 58, resetsAt: null }]);
    now += 600_000;
    first.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8").includes("work"), true);
    // Two hours later the router starts again.
    now += 2 * 3_600_000;
    const second = new Metrics({ path, now: () => now });
    const day = second.history("24h", "account:work", ["cacheRead", "quota"]);
    const values = day.series.cacheRead!;
    assert.equal(values.filter((v) => v === 5000).length, 1);
    const covered = values.map((v) => v !== null);
    const lastCovered = covered.lastIndexOf(true);
    assert.ok(lastCovered < values.length - 20, "the two hours offline are gaps");
    assert.equal(day.series["quota:five_hour"]!.filter((v) => v === 42).length, 1);
    assert.equal(second.history("2m", "account:work", ["cacheRead"]).series.cacheRead!.every((v) => v === null || v === 0), true, "short tiers are not persisted");
    second.close();
    const logs = captureLogs();
    writeFileSync(path, "{ not json");
    assert.doesNotThrow(() => new Metrics({ path, now: () => now }).close(), "a corrupt file is logged, not fatal");
    assert.match(logs.join("\n"), /metrics.load_failed/);
  });
});
