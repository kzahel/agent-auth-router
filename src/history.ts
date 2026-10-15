// Durable traffic history in one SQLite database: chart buckets, finished
// requests, the last quota reading per account and the retention setting.
// Metadata only, like the metrics it persists: no request content,
// credentials or profile paths. Sessions are derived from requests on demand.
// The router is the only writer; everything here runs on its thread.

import { chmodSync, existsSync, lstatSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { QuotaWindow } from "./quotas.ts";
import type { Provider } from "./types.ts";
import type { UsageFigures } from "./usage.ts";

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
const SCHEMA_VERSION = 1;

/** A finished request as stored; `RequestEntry` without the session-local id. */
export interface StoredRequest {
  requestId: string;
  startedAt: number;
  endedAt: number;
  client: string;
  accountId: string;
  provider: Provider;
  poolId: string | null;
  bindingId: string | null;
  sessionId: string | null;
  route: string;
  model: string | null;
  status: number | null;
  outcome: "ok" | "error" | "client_closed";
  bytesUp: number;
  bytesDown: number;
  usage: UsageFigures;
  estimated: boolean;
}

export interface SessionSummary {
  sessionId: string;
  client: string;
  provider: string;
  /** Accounts the session's requests used, most recent first. */
  accountIds: string[];
  model: string | null;
  firstAt: number;
  lastAt: number;
  requests: number;
  errors: number;
  usage: UsageFigures;
  /** Some output figures are live estimates the provider never replaced. */
  estimated: boolean;
}

export interface BucketRow { scope: string; tier: string; bucket: number; metric: string; value: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS buckets (
  scope TEXT NOT NULL, tier TEXT NOT NULL, bucket INTEGER NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (scope, tier, bucket, metric)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS coverage (
  scope TEXT NOT NULL, tier TEXT NOT NULL, bucket INTEGER NOT NULL,
  PRIMARY KEY (scope, tier, bucket)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS quota_latest (account_id TEXT PRIMARY KEY, at INTEGER NOT NULL, windows TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  client TEXT NOT NULL, account_id TEXT NOT NULL, provider TEXT NOT NULL, pool_id TEXT, binding_id TEXT, session_id TEXT,
  route TEXT NOT NULL, model TEXT, status INTEGER, outcome TEXT NOT NULL, bytes_up INTEGER NOT NULL, bytes_down INTEGER NOT NULL,
  input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  estimated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS requests_ended ON requests (ended_at);
CREATE INDEX IF NOT EXISTS requests_session ON requests (session_id, ended_at) WHERE session_id IS NOT NULL;
`;

type Row = Record<string, unknown>;
const num = (value: unknown): number => typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;

export class HistoryStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) throw new Error("insecure history database");
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
      this.db.exec(SCHEMA);
      const version = this.meta("schema");
      if (version !== null && Number(version) > SCHEMA_VERSION) throw new Error("history database is from a newer router");
      if (version === null) this.setMeta("schema", String(SCHEMA_VERSION));
      // The WAL and shared-memory files exist once the first write above ran.
      if (process.platform !== "win32") for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private meta(key: string): string | null {
    return str(this.statement("SELECT value FROM meta WHERE key = ?").get(key)?.value);
  }
  private setMeta(key: string, value: string): void {
    this.statement("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  /** Runs `work` in one transaction. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  retentionDays(): number {
    const days = Number(this.meta("retentionDays"));
    return Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS ? days : DEFAULT_RETENTION_DAYS;
  }
  setRetentionDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) throw new RangeError(`retention must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}`);
    this.setMeta("retentionDays", String(days));
  }

  /** Persisted chart buckets newer than `after` (exclusive) for one tier. */
  buckets(tier: string, after: number): BucketRow[] {
    return this.statement("SELECT scope, tier, bucket, metric, value FROM buckets WHERE tier = ? AND bucket > ?").all(tier, after)
      .map((r: Row) => ({ scope: String(r.scope), tier: String(r.tier), bucket: num(r.bucket), metric: String(r.metric), value: num(r.value) }));
  }
  coverage(tier: string, after: number): { scope: string; bucket: number }[] {
    return this.statement("SELECT scope, bucket FROM coverage WHERE tier = ? AND bucket > ?").all(tier, after)
      .map((r: Row) => ({ scope: String(r.scope), bucket: num(r.bucket) }));
  }
  putBucket(scope: string, tier: string, bucket: number, metric: string, value: number): void {
    this.statement("INSERT INTO buckets (scope, tier, bucket, metric, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value")
      .run(scope, tier, bucket, metric, value);
  }
  putCoverage(scope: string, tier: string, bucket: number): void {
    this.statement("INSERT OR IGNORE INTO coverage (scope, tier, bucket) VALUES (?, ?, ?)").run(scope, tier, bucket);
  }

  latestQuota(): { accountId: string; at: number; windows: unknown }[] {
    return this.statement("SELECT account_id, at, windows FROM quota_latest").all().flatMap((r: Row) => {
      try { return [{ accountId: String(r.account_id), at: num(r.at), windows: JSON.parse(String(r.windows)) as unknown }]; } catch { return []; }
    });
  }
  putQuota(accountId: string, at: number, windows: readonly QuotaWindow[]): void {
    this.statement("INSERT INTO quota_latest (account_id, at, windows) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at, windows = excluded.windows")
      .run(accountId, at, JSON.stringify(windows));
  }

  putRequest(r: StoredRequest): void {
    this.statement(`INSERT OR REPLACE INTO requests (request_id, started_at, ended_at, client, account_id, provider, pool_id, binding_id, session_id,
      route, model, status, outcome, bytes_up, bytes_down, input, cache_read, cache_write, output, reasoning, estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      r.requestId, r.startedAt, r.endedAt, r.client, r.accountId, r.provider, r.poolId, r.bindingId, r.sessionId,
      r.route, r.model, r.status, r.outcome, r.bytesUp, r.bytesDown,
      r.usage.input, r.usage.cacheRead, r.usage.cacheWrite, r.usage.output, r.usage.reasoning, r.estimated ? 1 : 0);
  }
  /** Most recent finished requests by start time, newest first, as the live list orders them. */
  recentRequests(limit: number): StoredRequest[] {
    return this.statement("SELECT * FROM requests ORDER BY started_at DESC LIMIT ?").all(limit).map(requestOf);
  }

  /**
   * Sessions with a request ending at or after `since`, newest activity
   * first, with totals over every stored request of each session. An account
   * or pool narrows which sessions qualify, not what they total.
   */
  sessions(since: number, filter: { accountId?: string; poolId?: string } = {}, limit = 50): SessionSummary[] {
    const where = filter.accountId ? "AND account_id = ?" : filter.poolId ? "AND pool_id = ?" : "";
    const params = [since, ...(filter.accountId ? [filter.accountId] : filter.poolId ? [filter.poolId] : []), limit];
    return this.statement(`
      WITH chosen AS (SELECT session_id FROM requests WHERE session_id IS NOT NULL AND ended_at >= ? ${where}
                      GROUP BY session_id ORDER BY max(ended_at) DESC LIMIT ?)
      SELECT r.session_id, max(r.client) AS client, max(r.provider) AS provider, min(r.started_at) AS first_at, max(r.ended_at) AS last_at,
        count(*) AS requests, sum(r.outcome = 'error') AS errors, sum(r.input) AS input, sum(r.cache_read) AS cache_read,
        sum(r.cache_write) AS cache_write, sum(r.output) AS output, sum(r.reasoning) AS reasoning, max(r.estimated) AS estimated,
        (SELECT json_group_array(account_id) FROM (SELECT account_id, max(ended_at) AS last FROM requests
           WHERE session_id = r.session_id GROUP BY account_id ORDER BY last DESC)) AS accounts,
        (SELECT model FROM requests WHERE session_id = r.session_id AND model IS NOT NULL ORDER BY ended_at DESC LIMIT 1) AS model
      FROM requests r JOIN chosen USING (session_id)
      GROUP BY r.session_id ORDER BY last_at DESC`).all(...params).map((r: Row) => ({
      sessionId: String(r.session_id), client: String(r.client), provider: String(r.provider),
      accountIds: JSON.parse(String(r.accounts)) as string[], model: str(r.model),
      firstAt: num(r.first_at), lastAt: num(r.last_at), requests: num(r.requests), errors: num(r.errors),
      usage: { input: num(r.input), cacheRead: num(r.cache_read), cacheWrite: num(r.cache_write), output: num(r.output), reasoning: num(r.reasoning) },
      estimated: num(r.estimated) > 0,
    }));
  }

  /** Deletes history older than the retention period; `tiers` maps tier names to bucket length. */
  prune(now: number, tiers: Record<string, number>): void {
    const cutoff = now - this.retentionDays() * 86_400_000;
    this.transaction(() => {
      this.statement("DELETE FROM requests WHERE ended_at < ?").run(cutoff);
      this.statement("DELETE FROM quota_latest WHERE at < ?").run(cutoff);
      for (const [tier, bucketMs] of Object.entries(tiers)) {
        const oldest = Math.floor(cutoff / bucketMs);
        this.statement("DELETE FROM buckets WHERE tier = ? AND bucket < ?").run(tier, oldest);
        this.statement("DELETE FROM coverage WHERE tier = ? AND bucket < ?").run(tier, oldest);
      }
    });
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}

function requestOf(r: Row): StoredRequest {
  return {
    requestId: String(r.request_id), startedAt: num(r.started_at), endedAt: num(r.ended_at), client: String(r.client),
    accountId: String(r.account_id), provider: String(r.provider) as Provider, poolId: str(r.pool_id), bindingId: str(r.binding_id),
    sessionId: str(r.session_id), route: String(r.route), model: str(r.model), status: r.status === null ? null : num(r.status),
    outcome: String(r.outcome) as StoredRequest["outcome"], bytesUp: num(r.bytes_up), bytesDown: num(r.bytes_down),
    usage: { input: num(r.input), cacheRead: num(r.cache_read), cacheWrite: num(r.cache_write), output: num(r.output), reasoning: num(r.reasoning) },
    estimated: num(r.estimated) > 0,
  };
}
