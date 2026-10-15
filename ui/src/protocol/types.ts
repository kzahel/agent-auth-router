// Payloads of the app protocol, as the UI reads them. Written from the
// core's operations (src/owner.ts, src/control.ts, src/metrics.ts,
// src/history.ts); only fields the UI uses are listed.

export type Provider = "claude" | "codex";
export type PoolPolicy = "manual" | "round-robin" | "most-remaining" | "weekly-pace";

export interface QuotaWindow {
  bucket: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface Account {
  id: string;
  home?: string;
  nickname: string | null;
  provider: Provider;
  enabled: boolean;
  retired?: boolean;
  imported?: boolean;
  revision: number;
  bindingCount?: number;
  freshness: "fresh" | "stale" | "unknown";
  windows: (QuotaWindow & { scope: string })[];
  quota?: { observedAt: string } | null;
  error?: string | null;
  blocked?: string | null;
}

export interface Pool {
  id: string;
  name: string;
  provider: Provider;
  policy: PoolPolicy | string;
  revision: number;
  accountIds: string[];
  bindings: { accountId: string; count: number }[];
}

export interface Integration {
  id: string;
  name: string;
  revision: number;
  revoked: boolean;
  poolIds: string[];
  accountIds: string[];
}

export interface Overview {
  routerId: string;
  build?: { version?: string; source?: string };
  activeRequests: number;
  accounts: Account[];
  pools: Pool[];
  integrations: Integration[];
  logins: { id: string; status: string }[];
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One proxied request; `outcome` is "active" while it streams. */
export interface RequestEntry {
  id: number;
  startedAt: number;
  endedAt: number | null;
  client: string;
  accountId: string;
  poolId: string | null;
  sessionId: string | null;
  route: string;
  model: string | null;
  status: number | null;
  outcome: "active" | "ok" | "error" | "client_closed";
  usage: Usage;
  estimated: boolean;
  cost: number | null;
  costFlags: number;
}

export type Counter = "requests" | "errors" | "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning"
  | "cacheWrite1h" | "webSearches" | "bytesUp" | "bytesSent" | "bytesDown" | "unreported";
export type RangeName = "2m" | "10m" | "1h" | "24h" | "30d";

export interface ScopeRates {
  active: number;
  sessions: number;
  /** Per second over the last five seconds. */
  rate: Record<Counter, number>;
  /** Totals over the last minute. */
  minute: Record<Counter, number>;
}

/** The `live` subscription's snapshot, repeated every tick. */
export interface LiveSnapshot {
  at: number;
  epoch: string;
  scopes: Record<string, ScopeRates>;
  quota?: Record<string, QuotaWindow[]>;
  quotaAt?: Record<string, number>;
  quotaChecking?: string[];
}

/** A `history` snapshot or append: bucket sums from `start` through `completeThrough`. */
export interface HistoryData {
  range: RangeName;
  scope: string;
  bucketMs: number;
  count: number;
  epoch: string;
  start: number;
  completeThrough: number;
  series: Record<string, (number | null)[]>;
}

/** The `activity` subscription: per account, the summed series per second. */
export interface ActivityData {
  range: RangeName;
  bucketMs: number;
  count: number;
  start: number;
  completeThrough: number;
  accounts: Record<string, (number | null)[]>;
}

export interface CostSummary {
  cost: number;
  low: number;
  requests: number;
  unpriced: number;
  estimated: number;
}

export interface SessionSummary {
  sessionId: string;
  client: string;
  accountIds: string[];
  model: string | null;
  firstAt: number;
  lastAt: number;
  requests: number;
  errors: number;
  usage: Usage;
  estimated: boolean;
  cost: CostSummary;
}

export interface RangeCost {
  summary: CostSummary | null;
  prices: { date: string };
}

export interface RemovalPreview {
  id: string;
  revision: number;
  home: string;
  canDeleteProfile: boolean;
  deleteIdentity: string | null;
  reason: string;
}

export interface LoginStatus {
  signIn: string;
  loginStatus: string;
  canOpenLogin?: boolean;
}

export type RequestCompression = Record<Provider, string>;
