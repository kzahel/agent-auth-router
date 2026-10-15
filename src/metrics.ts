// Traffic metrics and tiered history. Ring buffers follow rstorrent's speed
// history: every event adds into each tier at once (no downsampling cascade),
// buckets hold sums, and buckets the router was not running for are gaps.
// Metadata only: no request content, credentials or profile paths.

import { randomUUID } from "node:crypto";
import type { CostSummary, HistoryStore, SessionSummary } from "./history.ts";
import { log, errorText } from "./log.ts";
import { PRICES_VERSION, priceRequest } from "./pricing.ts";
import type { QuotaWindow } from "./quotas.ts";
import type { Provider } from "./types.ts";
import { USAGE_FIELDS, zeroUsage, type UsageAttributes, type UsageFigures } from "./usage.ts";

export const COUNTERS = ["requests", "errors", "input", "cacheRead", "cacheWrite", "output", "reasoning", "cacheWrite1h", "webSearches", "bytesUp", "bytesDown", "unreported"] as const;
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
const METRIC = /^(requests|errors|input|cacheRead|cacheWrite|output|reasoning|cacheWrite1h|webSearches|bytesUp|bytesDown|unreported|quota:[a-z0-9_:-]{1,40})$/;
export const isMetric = (value: unknown): value is string => typeof value === "string" && METRIC.test(value);
const RECENT_LIMIT = 200;
const SAVE_INTERVAL_MS = 60_000;
/** A session counts as active while a request runs and for this long after. */
const SESSION_ACTIVE_MS = 60_000;
const MAX_TRACKED_SESSIONS = 10_000;
const PRUNE_INTERVAL_MS = 86_400_000;
const PERSISTED = Object.entries(RANGES).filter(([, r]) => r.persist) as [RangeName, (typeof RANGES)[RangeName]][];

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
  /** The router's request id, as logged; stable across restarts unlike `id`. */
  requestId: string;
  startedAt: number;
  endedAt: number | null;
  client: string;
  accountId: string;
  provider: Provider;
  poolId: string | null;
  /** Session binding the credential belongs to, when allocated through control. */
  bindingId: string | null;
  /** The client's own session identifier, for joining to CLI rollouts. */
  sessionId: string | null;
  route: string;
  model: string | null;
  status: number | null;
  outcome: "active" | "ok" | "error" | "client_closed";
  bytesUp: number;
  bytesDown: number;
  usage: UsageFigures;
  /** Output includes a live estimate the provider never replaced. */
  estimated: boolean;
  /** The provider split cache writes into five-minute and one-hour; false keeps usage.cacheWrite1h unknown. */
  cacheSplit: boolean;
  /** Pricing context as the provider reported it, null when it did not. */
  speed: string | null;
  inferenceGeo: string | null;
  serviceTier: string | null;
  /** Estimated cost at API rates once finished; null while active or when the model has no price. */
  cost: number | null;
  /** history.ts COST_* bits. */
  costFlags: number;
  /** The cost if cache writes of unknown duration were one-hour; equals cost when known. */
  costHigh: number | null;
}

export interface RequestStart {
  provider: Provider;
  route: string;
  accountId: string;
  client: string;
  poolId?: string | undefined;
  requestId?: string | undefined;
  bindingId?: string | undefined;
  sessionId?: string | undefined;
  /** Whether this route reports inference usage. */
  tapped: boolean;
}

export interface RequestHandle {
  model(model: string): void;
  attributes(values: UsageAttributes): void;
  usage(change: UsageFigures, estimated: boolean, final: boolean): void;
  bytesUp(bytes: number): void;
  bytesDown(bytes: number): void;
  end(status: number, outcome?: string): void;
}

export type MetricsEvent = { type: "request"; entry: RequestEntry };

/** The last windows seen per account, kept across restarts for display only; pool evidence never reads it. */
interface LatestQuota { at: number; windows: QuotaWindow[] }
const MAX_LATEST_QUOTA = 256;

function persistedWindow(value: unknown): QuotaWindow | null {
  const w = value as Record<string, unknown> | null;
  const percent = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));
  if (!w || typeof w !== "object" || typeof w.bucket !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(w.bucket)
    || !percent(w.windowMinutes) || !percent(w.usedPercent) || !percent(w.remainingPercent)
    || !(w.resetsAt === null || (typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt))))) return null;
  return { bucket: w.bucket, windowMinutes: w.windowMinutes as number | null, usedPercent: w.usedPercent as number | null,
    remainingPercent: w.remainingPercent as number | null, resetsAt: w.resetsAt as string | null };
}

export class Metrics {
  private readonly scopes = new Map<string, Scope>();
  private readonly active = new Map<string, number>();
  /** Per scope and client session id: requests in flight and the last start or end. */
  private readonly sessionActivity = new Map<string, { scope: string; inFlight: number; at: number }>();
  private readonly recent: RequestEntry[] = [];
  private readonly latestQuota = new Map<string, LatestQuota>();
  private readonly listeners = new Set<(event: MetricsEvent) => void>();
  private readonly now: () => number;
  private readonly store: HistoryStore | undefined;
  /** Per scope and persisted tier, the oldest bucket not yet known to be saved. */
  private readonly unsaved = new Map<string, number>();
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];
  /** Called after history is pruned, with the retention in days. */
  onPrune?: (retentionDays: number) => void;
  /** Changes when history restarts, so clients refetch instead of appending. */
  readonly epoch = randomUUID();
  constructor(options: { history?: HistoryStore; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.history;
    this.scope("all");
    if (this.store) {
      try { this.load(this.store); } catch (error) { log("metrics.load_failed", { error: errorText(error) }); }
      this.timers = [setInterval(() => this.save(), SAVE_INTERVAL_MS), setInterval(() => this.prune(), PRUNE_INTERVAL_MS)];
      for (const timer of this.timers) timer.unref();
    }
  }
  private scope(key: string): Scope {
    let scope = this.scopes.get(key);
    if (!scope) {
      const now = this.now();
      scope = Object.fromEntries(Object.entries(RANGES).map(([name, r]) => [name, new Tier(r.bucketMs, r.count, now)])) as Scope;
      this.scopes.set(key, scope);
      for (const [name] of PERSISTED) this.unsaved.set(`${key}|${name}`, scope[name].head);
    }
    return scope;
  }
  private add(scopes: readonly string[], metric: Counter, value: number): void {
    if (!value) return;
    const now = this.now();
    for (const key of scopes) for (const tier of Object.values(this.scope(key))) tier.add(metric, value, now);
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
    if (start.sessionId) this.touchSessions(scopes, start.sessionId, 1);
    const entry: RequestEntry = {
      id: ++this.seq, requestId: start.requestId ?? randomUUID(), startedAt: this.now(), endedAt: null, client: start.client, accountId: start.accountId, provider: start.provider,
      poolId: start.poolId ?? null, bindingId: start.bindingId ?? null, sessionId: start.sessionId ?? null,
      route: start.route, model: null, status: null, outcome: "active", bytesUp: 0, bytesDown: 0,
      usage: zeroUsage(), estimated: false, cacheSplit: false, speed: null, inferenceGeo: null, serviceTier: null, cost: null, costFlags: 0, costHigh: null,
    };
    this.recent.push(entry);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    this.emit(entry);
    let ended = false, final = false;
    return {
      model: (model) => { entry.model = model; },
      attributes: (values) => {
        if (ended) return;
        if (values.cacheSplit) entry.cacheSplit = true;
        if (values.speed) entry.speed = values.speed;
        if (values.inferenceGeo) entry.inferenceGeo = values.inferenceGeo;
        if (values.serviceTier) entry.serviceTier = values.serviceTier;
      },
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
        if (start.sessionId) this.touchSessions(scopes, start.sessionId, -1);
        if (status >= 400) this.add(scopes, "errors", 1);
        if (start.tapped && status >= 200 && status < 300 && !final) this.add(scopes, "unreported", 1);
        entry.endedAt = this.now();
        entry.status = status;
        entry.outcome = outcome === "client_closed" ? "client_closed" : status >= 400 ? "error" : "ok";
        const priced = priceRequest(entry);
        entry.cost = priced.cost;
        entry.costFlags = priced.flags;
        entry.costHigh = priced.high;
        this.emit(entry);
        if (this.store) {
          const { id: _id, endedAt, outcome: finished, cost: _cost, costFlags: _flags, costHigh: _high, ...stored } = entry;
          try { this.store.putRequest({ ...stored, endedAt: endedAt!, outcome: finished as "ok" | "error" | "client_closed" }, priced); }
          catch (error) { log("metrics.request_save_failed", { error: errorText(error) }); }
        }
      },
    };
  }
  /** Records used-percent quota samples, per account only. */
  quota(accountId: string, windows: readonly QuotaWindow[]): void {
    const now = this.now(), scope = this.scope(`account:${accountId}`);
    if (windows.length) {
      this.latestQuota.delete(accountId);
      this.latestQuota.set(accountId, { at: now, windows: windows.map(w => ({ ...w })) });
      if (this.latestQuota.size > MAX_LATEST_QUOTA) this.latestQuota.delete(this.latestQuota.keys().next().value!);
      try { this.store?.putQuota(accountId, now, windows); } catch (error) { log("metrics.quota_save_failed", { error: errorText(error) }); }
    }
    for (const w of windows) {
      if (w.usedPercent === null || !Number.isFinite(w.usedPercent)) continue;
      const metric = `quota:${w.bucket}`;
      if (!isMetric(metric)) continue;
      for (const tier of Object.values(scope)) tier.gauge(metric, Math.max(0, Math.min(100, w.usedPercent)), now);
    }
  }
  scopeKeys(): string[] { return [...this.scopes.keys()]; }
  /**
   * Per account, the per-second sum of `metrics` over one tier's complete
   * buckets, for the accounts table; null marks buckets the router was not running.
   */
  activity(range: RangeName, metrics: readonly Counter[]) {
    const { bucketMs, count } = RANGES[range], perSecond = bucketMs / 1000;
    const head = Math.floor(this.now() / bucketMs), completeThrough = head - 1, start = completeThrough - count + 1;
    const accounts: Record<string, (number | null)[]> = {};
    for (const [key, scope] of this.scopes) {
      if (!key.startsWith("account:")) continue;
      const tier = scope[range];
      tier.advance(this.now());
      const column: (number | null)[] = [];
      for (let b = start; b <= completeThrough; b++) {
        const parts = metrics.map(m => tier.value(m, b));
        column.push(parts.every(v => v === null) ? null : parts.reduce<number>((sum, v) => sum + (v ?? 0), 0) / perSecond);
      }
      accounts[key.slice(8)] = column;
    }
    return { range, metrics: [...metrics], bucketMs, count, start, completeThrough, accounts };
  }
  history(range: RangeName, scopeKey: string, metrics: readonly string[] = COUNTERS, after?: number) {
    const tier = this.scope(scopeKey)[range];
    tier.advance(this.now());
    const quotaMetrics = metrics.includes("quota") ? [...tier.series.keys()].filter(isGauge) : [];
    const rows = tier.rows([...metrics.filter(m => m !== "quota"), ...quotaMetrics], after);
    return { range, scope: scopeKey, bucketMs: tier.bucketMs, count: tier.count, epoch: this.epoch, ...rows };
  }
  private touchSessions(scopes: readonly string[], sessionId: string, change: 1 | -1): void {
    const now = this.now();
    for (const scope of scopes) {
      const key = `${scope}\n${sessionId}`, entry = this.sessionActivity.get(key) ?? { scope, inFlight: 0, at: now };
      entry.inFlight = Math.max(0, entry.inFlight + change);
      entry.at = now;
      this.sessionActivity.set(key, entry);
    }
    if (this.sessionActivity.size > MAX_TRACKED_SESSIONS) this.sessionCounts(now);
  }
  /** Distinct client sessions per scope with a request running or within the last minute; forgets the rest. */
  private sessionCounts(now: number): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [key, entry] of this.sessionActivity) {
      if (entry.inFlight === 0 && now - entry.at > SESSION_ACTIVE_MS) { this.sessionActivity.delete(key); continue; }
      counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
    }
    return counts;
  }
  /** Current gauges, rates over the last five complete seconds and one-minute sums. */
  snapshot() {
    const now = this.now(), sessions = this.sessionCounts(now);
    const scopes: Record<string, { active: number; sessions: number; rate: Record<Counter, number>; minute: Record<Counter, number> }> = {};
    for (const [key, scope] of this.scopes) {
      const tier = scope["2m"];
      tier.advance(now);
      const rate = {} as Record<Counter, number>, minute = {} as Record<Counter, number>;
      for (const metric of COUNTERS) { rate[metric] = tier.sum(metric, 5) / 5; minute[metric] = tier.sum(metric, 60); }
      scopes[key] = { active: this.active.get(key) ?? 0, sessions: sessions.get(key) ?? 0, rate, minute };
    }
    const quota: Record<string, QuotaWindow[]> = {}, quotaAt: Record<string, number> = {};
    for (const [id, latest] of this.latestQuota) { quota[id] = latest.windows.map(w => ({ ...w })); quotaAt[id] = latest.at; }
    return { at: now, epoch: this.epoch, scopes, quota, quotaAt, activeRequests: this.recent.filter(e => e.outcome === "active").map(e => structuredClone(e)) };
  }
  recentRequests(after = 0): RequestEntry[] {
    return this.recent.filter(e => e.id > after).reverse().map(e => structuredClone(e));
  }
  /** Cost at API rates of requests finished since `since`; null without a history store. */
  costSummary(since: number, filter: { accountId?: string; poolId?: string } = {}): CostSummary | null {
    return this.store?.costSummary(since, filter) ?? null;
  }
  /** Sessions with activity since `since`; empty without a history store. */
  sessions(since: number, filter: { accountId?: string; poolId?: string } = {}): SessionSummary[] {
    return this.store?.sessions(since, filter) ?? [];
  }
  retentionDays(): number | null { return this.store?.retentionDays() ?? null; }
  setRetentionDays(days: number): void {
    if (!this.store) throw new Error("history is not stored");
    this.store.setRetentionDays(days);
    this.prune();
  }
  /** Deletes stored history past the retention period. */
  prune(): void {
    if (!this.store) return;
    try {
      this.store.prune(this.now(), Object.fromEntries(PERSISTED.map(([name, r]) => [name, r.bucketMs])));
      this.onPrune?.(this.store.retentionDays());
    } catch (error) { log("metrics.prune_failed", { error: errorText(error) }); }
  }
  private load(history: HistoryStore): void {
    const now = this.now();
    for (const [name, range] of PERSISTED) {
      const head = Math.floor(now / range.bucketMs), after = head - range.count;
      const tiers = (key: string) => isScope(key) ? this.scope(key)[name] : undefined;
      const restored = new Set<string>();
      // Covered buckets are those the router was running for; downtime stays a gap.
      for (const { scope, bucket } of history.coverage(name, after)) {
        const tier = tiers(scope);
        if (!tier || bucket > tier.head) continue;
        if (!restored.has(scope)) { tier.covered.fill(0); tier.covered[tier.head % tier.count] = 1; restored.add(scope); }
        tier.covered[((bucket % tier.count) + tier.count) % tier.count] = 1;
      }
      for (const row of history.buckets(name, after)) {
        if (!isMetric(row.metric) || !Number.isFinite(row.value)) continue;
        tiers(row.scope)?.restore(row.metric, row.bucket, row.value);
      }
    }
    for (const { accountId, at, windows } of history.latestQuota().slice(-MAX_LATEST_QUOTA)) {
      if (accountId.length > 200 || !Number.isSafeInteger(at) || at > now || !Array.isArray(windows)) continue;
      const valid = windows.slice(0, 32).map(persistedWindow).filter(w => w !== null);
      if (valid.length) this.latestQuota.set(accountId, { at, windows: valid });
    }
    // Costs follow the vendored price table: reprice stored history when it or the rules change.
    if (history.pricesVersion() !== PRICES_VERSION) {
      const count = history.reprice(priceRequest, PRICES_VERSION);
      log("history.repriced", { requests: count, version: PRICES_VERSION });
    }
    for (const stored of history.recentRequests(RECENT_LIMIT).reverse()) this.recent.push({ ...stored, id: ++this.seq });
    this.prune();
  }
  /** Writes buckets entered or changed since the last save, and their coverage. */
  save(): void {
    if (!this.store) return;
    const now = this.now();
    try {
      this.store.transaction(() => {
        for (const [key, scope] of this.scopes) for (const [name] of PERSISTED) {
          const tier = scope[name], id = `${key}|${name}`;
          tier.advance(now);
          const from = Math.max(this.unsaved.get(id) ?? tier.head, tier.head - tier.count + 1);
          for (let b = from; b <= tier.head; b++) {
            const i = ((b % tier.count) + tier.count) % tier.count;
            if (!tier.covered[i]) continue;
            this.store!.putCoverage(key, name, b);
            for (const [metric, values] of tier.series) if (values[i] !== 0 && !Number.isNaN(values[i]!)) this.store!.putBucket(key, name, b, metric, values[i]!);
          }
          // The head bucket can still change, so it is saved again next time.
          this.unsaved.set(id, tier.head);
        }
      });
    } catch (error) { log("metrics.save_failed", { error: errorText(error) }); }
  }
  close(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.save();
  }
}
