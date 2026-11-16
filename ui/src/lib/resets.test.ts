import { describe, expect, it } from "vitest";
import { account } from "../test/fake-app.tsx";
import { accountName, allResets, expiresIn, resetUrgency, soonCount } from "./resets.ts";

const now = Date.parse("2026-11-16T12:00:00Z");
const after = (ms: number) => new Date(now + ms).toISOString();
const HOUR = 3_600_000, DAY = 24 * HOUR;

describe("limit reset expiry", () => {
  it("warns more strongly as expiry nears: two weeks, a week, a day", () => {
    expect([after(-1), after(5 * HOUR), after(DAY), after(6 * DAY), after(7 * DAY), after(13 * DAY), after(14 * DAY), null, "garbage"]
      .map(at => resetUrgency(at, now))).toEqual(["expired", "day", "week", "week", "fortnight", "fortnight", "later", "unknown", "unknown"]);
  });

  it("counts down in whole units", () => {
    expect([after(30_000), after(5 * 60_000), after(HOUR), after(23 * HOUR + 59 * 60_000), after(DAY), after(13 * DAY + 23 * HOUR), after(20 * DAY), after(90 * DAY), after(-1), null]
      .map(at => expiresIn(at, now))).toEqual(["in 1 minute", "in 5 minutes", "in 1 hour", "in 23 hours", "in 1 day", "in 13 days", "in 20 days", "in 3 months", "expired", "no expiry reported"]);
  });

  it("lists unused resets across accounts soonest first, and counts those due within a week", () => {
    const reset = (label: string, expiresAt: string | null, available = 1) => ({ label, available, total: available, expiresAt, usableNow: true });
    const accounts = [
      account("a", { quota: { observedAt: after(0), limitResets: { observedAt: after(0), available: 3, resets: [reset("late", after(30 * DAY)), reset("never", null), reset("spent", after(DAY), 0)] } } }),
      account("b", { quota: { observedAt: after(0), limitResets: { observedAt: after(0), available: 2, resets: [reset("soon", after(2 * DAY), 2)] } } }),
      account("c", { quota: { observedAt: after(0), limitResets: { observedAt: after(0), available: null, resets: [], error: "unknown" } } }),
      account("d"),
    ];
    expect(allResets(accounts).map(r => `${r.account.id}:${r.label}`)).toEqual(["b:soon", "a:late", "a:never"]);
    expect(soonCount(accounts, now)).toBe(2);
  });
});

it("names accounts by nickname, else by id, shortening generated ids", () => {
  expect(accountName(account("work", { nickname: "Work" }))).toBe("Work");
  expect(accountName(account("codex-extra"))).toBe("codex-extra");
  expect(accountName(account("77e05016-d062-431b-a551-9353a43cc415"))).toBe("77e05016…");
});
