import { describe, expect, it } from "vitest";
import { ago, formatBytes, formatCost, formatNumber } from "./format.ts";
import { elapsedPercent, quotaLabel } from "./quota.ts";

describe("formatting", () => {
  it("abbreviates counts", () => {
    expect([0, 0.25, 6, 12.6, 999, 1000, 9_400, 27_000, 1_500_000, 2e10].map(formatNumber))
      .toEqual(["0", "0.3", "6.0", "13", "999", "1.0k", "9.4k", "27k", "1.5M", "20B"]);
    expect([null, undefined, NaN, Infinity].map(formatNumber)).toEqual(["–", "–", "–", "–"]);
  });

  it("uses decimal byte units", () => {
    expect([0, 999, 1000, 1500, 250_000, 3_200_000_000, 5e12].map(formatBytes))
      .toEqual(["0 B", "999 B", "1.0 KB", "1.5 KB", "250 KB", "3.2 GB", "5000 GB"]);
  });

  it("formats costs, with a floor for tiny amounts", () => {
    expect([0, 0.004, 0.01, 1.234, 1234.5].map(formatCost)).toEqual(["$0.00", "<$0.01", "$0.01", "$1.23", "$1,235"]);
  });

  it("says how long ago", () => {
    const now = 1_000_000_000;
    expect([now - 5_000, now - 120_000, now - 7_200_000, now - 3 * 86_400_000, now + 5_000].map(at => ago(at, now)))
      .toEqual(["5 s ago", "2 min ago", "2 h ago", "3 d ago", "0 s ago"]);
  });
});

describe("quota windows", () => {
  it("labels buckets briefly", () => {
    expect(quotaLabel({ bucket: "five_hour" })).toBe("5h");
    expect(quotaLabel({ bucket: "seven_day_opus" })).toBe("7d opus");
    expect(quotaLabel({ bucket: "codex:primary", windowMinutes: 300 })).toBe("5h");
    expect(quotaLabel({ bucket: "codex:secondary", windowMinutes: 10_080 })).toBe("7d");
    expect(quotaLabel({ bucket: "codex:primary", windowMinutes: 45 })).toBe("45m");
    expect(quotaLabel({ bucket: "codex:primary", windowMinutes: null })).toBe("primary");
  });

  it("places the pace mark by elapsed time", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const window = { bucket: "five_hour", windowMinutes: 300, usedPercent: 10, remainingPercent: 90, resetsAt: "2026-10-15T13:00:00Z" };
    expect(elapsedPercent(window, now)).toBeCloseTo(80);
    expect(elapsedPercent({ ...window, resetsAt: null }, now)).toBeNull();
    expect(elapsedPercent({ ...window, resetsAt: "2026-10-15T20:00:00Z" }, now)).toBeNull();
  });
});
