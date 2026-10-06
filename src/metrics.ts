// Traffic metrics and tiered history. Ring buffers follow rstorrent's speed
// history: every event adds into each tier at once (no downsampling cascade),
// buckets hold sums, and buckets the router was not running for are gaps.
// Metadata only: no request content, credentials or profile paths.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { log, errorText } from "./log.ts";
import type { QuotaWindow } from "./quotas.ts";
import { writePrivateJson } from "./state.ts";
import type { Provider } from "./types.ts";
import { USAGE_FIELDS, zeroUsage, type UsageFigures } from "./usage.ts";

export const COUNTERS = ["requests", "errors", "input", "cacheRead", "cacheWrite", "output", "reasoning", "bytesUp", "bytesDown", "unreported"] as const;
export type Counter = (typeof COUNTERS)[number];

export const RANGES = {
  "2m": { bucketMs: 1_000, count: 120, persist: false },
  "10m": { bucketMs: 5_000, count: 120, persist: false },
  "1h": { bucketMs: 30_000, count: 120, persist: false },
  "24h": { bucketMs: 300_000, count: 288, persist: true },
  "30d": { bucketMs: 3_600_000, count: 720, persist: true },
} as const;
export type RangeName = keyof typeof RANGES;
export const isRange = (value: unknown): value is RangeName => typeof value === "string" && Object.hasOwn(RANGES, value);

/** Quota gauges store the last used-percent sample per bucket, not a sum. */
const isGauge = (metric: string) => metric.startsWith("quota:");
const SCOPE = /^(all|account:[a-z0-9][a-z0-9-]{0,62}|pool:[a-f0-9-]{36})$/;
export const isScope = (value: unknown): value is string => typeof value === "string" && SCOPE.test(value);
const METRIC = /^(requests|errors|input|cacheRead|cacheWrite|output|reasoning|bytesUp|bytesDown|unreported|quota:[a-z0-9_:-]{1,40})$/;
export const isMetric = (value: unknown): value is string => typeof value === "string" && METRIC.test(value);
const RECENT_LIMIT = 200;
const SAVE_INTERVAL_MS = 60_000;

class Tier {
  readonly bucketMs: number;
  readonly count: number;
  head: number;
  readonly covered: Uint8Array;
  readonly series = new Map<string, Float64Array>();
  constructor(bucketMs: number, count: number, now: number) {
    this.bucketMs = bucketMs;
    this.count = count;
    this.covered = new Uint8Array(count);
    this.head = Math.floor(now / bucketMs);
    this.covered[this.head % count] = 1;
  }
  private index(bucket: number): number { return ((bucket % this.count) + this.count) % this.count; }
  /** Zero-fills buckets entered since the last event; work is capped at `count`. */
  advance(now: number, cover = true): void {
    const bucket = Math.floor(now / this.bucketMs);
    if (bucket <= this.head) return;
    const from = Math.max(this.head + 1, bucket - this.count + 1);
    for (let b = from; b <= bucket; b++) {
      const i = this.index(b);
      this.covered[i] = cover || b === bucket ? 1 : 0;
      for (const [metric, values] of this.series) values[i] = isGauge(metric) ? NaN : 0;
    }
    this.head = bucket;
  }
  private values(metric: string): Float64Array {
    let values = this.series.get(metric);
    if (!values) {
      values = new Float64Array(this.count);
      if (isGauge(metric)) values.fill(NaN);
      this.series.set(metric, values);
    }
    return values;
  }
  add(metric: string, value: number, now: number): void {
    this.advance(now);
    this.values(metric)[this.index(this.head)]! += value;
  }
  gauge(metric: string, value: number, now: number): void {
    this.advance(now);
    this.values(metric)[this.index(this.head)] = value;
  }
  /** Restores a persisted bucket without moving the head. */
  restore(metric: string, bucket: number, value: number): void {
    if (bucket > this.head || bucket <= this.head - this.count) return;
    this.values(metric)[this.index(bucket)] = value;
  }
  value(metric: string, bucket: number): number | null {
    if (bucket > this.head || bucket <= this.head - this.count) return null;
    const i = this.index(bucket);
    if (!this.covered[i]) return null;
    const values = this.series.get(metric);
    const value = values ? values[i]! : isGauge(metric) ? NaN : 0;
    return Number.isNaN(value) ? null : value;
  }
  /** Complete buckets only: the head bucket is still filling. */
  rows(metrics: readonly string[], after?: number): { start: number; completeThrough: number; series: Record<string, (number | null)[]> } {
    const completeThrough = this.head - 1;
    const oldest = completeThrough - this.count + 2;
    const start = after === undefined || after < oldest - 1 ? oldest : after + 1;
    const series: Record<string, (number | null)[]> = {};
    for (const metric of metrics) {
      const column: (number | null)[] = [];
      for (let b = start; b <= completeThrough; b++) column.push(this.value(metric, b));
      series[metric] = column;
    }
    return { start, completeThrough, series };
  }
  sum(metric: string, buckets: number): number {
    let total = 0;
    for (let b = this.head - buckets; b < this.head; b++) total += this.value(metric, b) ?? 0;
    return total;
  }
}

type Scope = Record<RangeName, Tier>;

export interface RequestEntry {
  id: number;
  startedAt: number;
  endedAt: number | null;
  client: string;
  accountId: string;
  provider: Provider;
  poolId: string | null;
  route: string;
  model: string | null;
  status: number | null;
  outcome: "active" | "ok" | "error" | "client_closed";
  bytesUp: number;
  bytesDown: number;
  usage: UsageFigures;
  /** Output includes a live estimate the provider never replaced. */
  estimated: boolean;
}

export interface RequestStart {
  provider: Provider;
  route: string;
  accountId: string;
  client: string;
  poolId?: string | undefined;
  /** Whether this route reports inference usage. */
  tapped: boolean;
}

export interface RequestHandle {
  model(model: string): void;
  usage(change: UsageFigures, estimated: boolean, final: boolean): void;
  bytesUp(bytes: number): void;
  bytesDown(bytes: number): void;
  end(status: number, outcome?: string): void;
}

export type MetricsEvent = { type: "request"; entry: RequestEntry };

interface PersistedTier { head: number; covered: [number, number][]; series: Record<string, [number, number][]> }
interface PersistedMetrics { version: 1; savedAt: number; scopes: Record<string, Partial<Record<RangeName, PersistedTier>>> }

export class Metrics {
  private readonly scopes = new Map<string, Scope>();
  private readonly active = new Map<string, number>();
  private readonly recent: RequestEntry[] = [];
  private readonly latestQuota = new Map<string, QuotaWindow[]>();
  private readonly listeners = new Set<(event: MetricsEvent) => void>();
  private readonly now: () => number;
  private readonly path: string | undefined;
  private seq = 0;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  /** Changes when history restarts, so clients refetch instead of appending. */
  readonly epoch = randomUUID();
  constructor(options: { path?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.path = options.path;
    this.scope("all");
    if (this.path) {
      try { this.load(this.path); } catch (error) { log("metrics.load_failed", { error: errorText(error) }); }
      this.timer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
      this.timer.unref();
    }
  }
  private scope(key: string): Scope {
    let scope = this.scopes.get(key);
    if (!scope) {
      const now = this.now();
      scope = Object.fromEntries(Object.entries(RANGES).map(([name, r]) => [name, new Tier(r.bucketMs, r.count, now)])) as Scope;
      this.scopes.set(key, scope);
    }
    return scope;
  }
  private add(scopes: readonly string[], metric: Counter, value: number): void {
    if (!value) return;
    const now = this.now();
    for (const key of scopes) for (const tier of Object.values(this.scope(key))) tier.add(metric, value, now);
    this.dirty = true;
  }
  onEvent(listener: (event: MetricsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(entry: RequestEntry): void {
    for (const listener of this.listeners) {
      try { listener({ type: "request", entry: structuredClone(entry) }); } catch { /* Listeners cannot break accounting. */ }
    }
  }
  begin(start: RequestStart): RequestHandle {
    const scopes = ["all", `account:${start.accountId}`, ...(start.poolId ? [`pool:${start.poolId}`] : [])];
    for (const key of scopes) this.active.set(key, (this.active.get(key) ?? 0) + 1);
    this.add(scopes, "requests", 1);
    const entry: RequestEntry = {
      id: ++this.seq, startedAt: this.now(), endedAt: null, client: start.client, accountId: start.accountId, provider: start.provider,
      poolId: start.poolId ?? null, route: start.route, model: null, status: null, outcome: "active", bytesUp: 0, bytesDown: 0,
      usage: zeroUsage(), estimated: false,
    };
    this.recent.push(entry);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    this.emit(entry);
    let ended = false, final = false;
    return {
      model: (model) => { entry.model = model; },
      usage: (change, estimated, isFinal) => {
        if (ended) return;
        for (const field of USAGE_FIELDS) { entry.usage[field] += change[field]; this.add(scopes, field, change[field]); }
        entry.estimated = estimated;
        final ||= isFinal;
      },
      bytesUp: (bytes) => { if (!ended) { entry.bytesUp += bytes; this.add(scopes, "bytesUp", bytes); } },
      bytesDown: (bytes) => { if (!ended) { entry.bytesDown += bytes; this.add(scopes, "bytesDown", bytes); } },
      end: (status, outcome) => {
        if (ended) return;
        ended = true;
        for (const key of scopes) {
          const next = (this.active.get(key) ?? 1) - 1;
          if (next > 0) this.active.set(key, next); else this.active.delete(key);
        }
        if (status >= 400) this.add(scopes, "errors", 1);
        if (start.tapped && status >= 200 && status < 300 && !final) this.add(scopes, "unreported", 1);
        entry.endedAt = this.now();
        entry.status = status;
        entry.outcome = outcome === "client_closed" ? "client_closed" : status >= 400 ? "error" : "ok";
        this.emit(entry);
      },
    };
  }
  /** Records used-percent quota samples, per account only. */
  quota(accountId: string, windows: readonly QuotaWindow[]): void {
    const now = this.now(), scope = this.scope(`account:${accountId}`);
    if (windows.length) this.latestQuota.set(accountId, windows.map(w => ({ ...w })));
    for (const w of windows) {
      if (w.usedPercent === null || !Number.isFinite(w.usedPercent)) continue;
      const metric = `quota:${w.bucket}`;
      if (!isMetric(metric)) continue;
      for (const tier of Object.values(scope)) tier.gauge(metric, Math.max(0, Math.min(100, w.usedPercent)), now);
      this.dirty = true;
    }
  }
  scopeKeys(): string[] { return [...this.scopes.keys()]; }
  history(range: RangeName, scopeKey: string, metrics: readonly string[] = COUNTERS, after?: number) {
    const tier = this.scope(scopeKey)[range];
    tier.advance(this.now());
    const quotaMetrics = metrics.includes("quota") ? [...tier.series.keys()].filter(isGauge) : [];
    const rows = tier.rows([...metrics.filter(m => m !== "quota"), ...quotaMetrics], after);
    return { range, scope: scopeKey, bucketMs: tier.bucketMs, count: tier.count, epoch: this.epoch, ...rows };
  }
  /** Current gauges and rates over the last five complete seconds. */
  snapshot() {
    const now = this.now(), scopes: Record<string, { active: number; rate: Record<Counter, number>; minute: Record<Counter, number> }> = {};
    for (const [key, scope] of this.scopes) {
      const tier = scope["2m"];
      tier.advance(now);
      const rate = {} as Record<Counter, number>, minute = {} as Record<Counter, number>;
      for (const metric of COUNTERS) { rate[metric] = tier.sum(metric, 5) / 5; minute[metric] = tier.sum(metric, 60); }
      scopes[key] = { active: this.active.get(key) ?? 0, rate, minute };
    }
    return { at: now, epoch: this.epoch, scopes, quota: Object.fromEntries(this.latestQuota), activeRequests: this.recent.filter(e => e.outcome === "active").map(e => structuredClone(e)) };
  }
  recentRequests(after = 0): RequestEntry[] {
    return this.recent.filter(e => e.id > after).reverse().map(e => structuredClone(e));
  }
  private load(path: string): void {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) throw new Error("insecure metrics state");
    const value = JSON.parse(readFileSync(path, "utf8")) as PersistedMetrics;
    if (value?.version !== 1 || !value.scopes || typeof value.scopes !== "object") throw new Error("unsupported metrics state");
    const now = this.now();
    for (const [key, ranges] of Object.entries(value.scopes)) {
      if (!isScope(key) || !ranges || typeof ranges !== "object") continue;
      const scope = this.scope(key);
      for (const [name, saved] of Object.entries(ranges)) {
        if (!isRange(name) || !RANGES[name].persist || !saved || !Number.isSafeInteger(saved.head)) continue;
        const tier = scope[name];
        if (saved.head > tier.head) continue;
        tier.head = saved.head;
        tier.covered.fill(0);
        const live = (b: number) => Number.isSafeInteger(b) && b <= saved.head && b > saved.head - tier.count;
        for (const [from, to] of Array.isArray(saved.covered) ? saved.covered : []) {
          for (let b = Math.max(from, saved.head - tier.count + 1); live(b) && b <= to; b++) tier.covered[((b % tier.count) + tier.count) % tier.count] = 1;
        }
        for (const [metric, points] of Object.entries(saved.series ?? {})) {
          if (!isMetric(metric) || !Array.isArray(points)) continue;
          for (const point of points) {
            if (!Array.isArray(point) || !live(point[0]) || typeof point[1] !== "number" || !Number.isFinite(point[1])) continue;
            tier.restore(metric, point[0], point[1]);
          }
        }
        // Time the router was not running stays uncovered.
        tier.advance(now, false);
      }
    }
  }
  save(): void {
    if (!this.path || !this.dirty) return;
    const scopes: PersistedMetrics["scopes"] = {};
    for (const [key, scope] of this.scopes) {
      const ranges: Partial<Record<RangeName, PersistedTier>> = {};
      for (const name of Object.keys(RANGES) as RangeName[]) {
        if (!RANGES[name].persist) continue;
        const tier = scope[name], series: Record<string, [number, number][]> = {};
        tier.advance(this.now());
        for (const [metric, values] of tier.series) {
          const points: [number, number][] = [];
          for (let b = tier.head - tier.count + 1; b <= tier.head; b++) {
            const i = ((b % tier.count) + tier.count) % tier.count;
            if (tier.covered[i] && values[i] !== 0 && !Number.isNaN(values[i]!)) points.push([b, values[i]!]);
          }
          if (points.length) series[metric] = points;
        }
        const covered: [number, number][] = [];
        for (let b = tier.head - tier.count + 1; b <= tier.head; b++) {
          if (!tier.covered[((b % tier.count) + tier.count) % tier.count]) continue;
          const last = covered.at(-1);
          if (last && last[1] === b - 1) last[1] = b; else covered.push([b, b]);
        }
        ranges[name] = { head: tier.head, covered, series };
      }
      scopes[key] = ranges;
    }
    try {
      writePrivateJson(this.path, { version: 1, savedAt: this.now(), scopes } satisfies PersistedMetrics);
      this.dirty = false;
    } catch (error) { log("metrics.save_failed", { error: errorText(error) }); }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.save();
  }
}
