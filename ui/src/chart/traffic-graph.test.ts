import { beforeAll, describe, expect, it, vi } from "vitest";
import type { HistoryData } from "../protocol/types.ts";
import { TrafficGraph, niceMaximum, runs, spanLabel, tangents } from "./traffic-graph.ts";

describe("scale and curve helpers", () => {
  it("rounds a maximum up to 1, 2 or 5 times a power of ten", () => {
    expect([0, 0.3, 1, 1.1, 2, 2.1, 7, 10, 11, 4_900, 51_000].map(v => niceMaximum(v))).toEqual([1, 1, 1, 2, 2, 5, 10, 10, 20, 5_000, 100_000]);
    expect(niceMaximum(0.03, 0.01)).toBe(0.05);
  });

  it("splits covered buckets into runs", () => {
    const covered = new Set([0, 1, 4, 6, 7, 8]);
    expect(runs(10, i => covered.has(i))).toEqual([[0, 1], [4], [6, 7, 8]]);
    expect(runs(3, () => false)).toEqual([]);
  });

  it("flattens tangents at extremes so curves do not overshoot", () => {
    const t = tangents([{ x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(t[1]).toBe(0);
    expect(t[2]).toBe(0);
    expect(t[3]).toBe(0);
  });

  it("labels the time span", () => {
    expect([120_000, 3_600_000, 86_400_000 * 30, 5_000].map(spanLabel)).toEqual(["2 min", "1 h", "30 days", "5 s"]);
  });
});

describe("TrafficGraph data", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("requestAnimationFrame", () => 1);
  });
  const snapshot = (overrides: Partial<HistoryData> = {}): HistoryData => ({
    range: "2m", scope: "all", bucketMs: 1000, count: 4, epoch: "e", start: 10, completeThrough: 12,
    series: { output: [1, null, 3] }, ...overrides,
  });
  const graph = () => new TrafficGraph(document.createElement("canvas"), document.createElement("div"));

  it("appends contiguous buckets and drops those that scroll out", () => {
    const g = graph();
    expect(g.update({ type: "snapshot", data: snapshot() })).toBe(true);
    expect(g.update({ type: "history", data: snapshot({ start: 13, completeThrough: 14, series: { output: [4, 5], input: [6, 7] } }) })).toBe(true);
    expect(g.data).toMatchObject({ start: 11, completeThrough: 14, series: { output: [null, 3, 4, 5], input: [null, null, 6, 7] } });
    expect(g.value("output", 3)).toBe(5);
    expect(g.value("output", 0)).toBeNull();
  });

  it("asks for a refetch when an append does not continue the data", () => {
    const g = graph();
    expect(g.update({ type: "history", data: snapshot() })).toBe(false);
    g.update({ type: "snapshot", data: snapshot() });
    expect(g.update({ type: "history", data: snapshot({ start: 14, completeThrough: 14 }) })).toBe(false);
    expect(g.update({ type: "history", data: snapshot({ start: 13, completeThrough: 13, epoch: "restarted" }) })).toBe(false);
    expect(g.update({ type: "history", data: snapshot({ start: 13, completeThrough: 13, scope: "pool:x" }) })).toBe(false);
  });

  it("converts sums to rates, and holds gauges between samples", () => {
    const g = graph();
    g.update({ type: "snapshot", data: snapshot({ bucketMs: 5000, series: { output: [10, null, 30] } }) });
    expect(g.value("output", 0)).toBe(2);
    g.configure([], { rate: false });
    expect(g.value("output", 1)).toBe(10);
    expect(g.value("output", 2)).toBe(30);
  });
});
