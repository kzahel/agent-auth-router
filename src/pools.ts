// Pool observations are metadata only. Reading an overview never runs a provider.
import type { CatalogModel, CliModel } from "./contract.ts";
import { normalizeResponseHeaderQuotas, type QuotaRead, type QuotaSnapshot, type QuotaWindow, type ResponseHeaders } from "./quotas.ts";
import type { Provider } from "./types.ts";

export const POOL_POLICIES = ["manual", "round-robin", "most-remaining"] as const;
export type PoolPolicy = typeof POOL_POLICIES[number];
export const isPoolPolicy = (value: unknown): value is PoolPolicy => POOL_POLICIES.includes(value as PoolPolicy);
export interface SelectionEvidence {
  headroomPercent: number | null;
  limitingBuckets: string[];
  reservations: number;
  catalogAt: string | null;
  quotaAt: string | null;
}
export interface Pool {
  id: string; name: string; provider: Provider;
  accountIds: string[]; policy: PoolPolicy; revision: number;
  deleted?: boolean; cursor?: string;
}
export const QUOTA_FRESH_MS = 120_000;
const QUOTA_REFRESH_UNAVAILABLE = "Quota refresh unavailable";
export const CATALOG_FRESH_MS = 60_000;
/** CLI model rows change with CLI releases, not per request. */
export const CLI_MODELS_FRESH_MS = 3_600_000;
const CLI_MODELS_RETRY_MS = 300_000;
export type EligibilityReason = "eligible" | "disabled" | "model-required" | "catalog-unknown" | "catalog-stale" | "model-unavailable" | "quota-unknown" | "quota-stale" | "scope-unknown" | "exhausted" | "reset-unverified" | "cooldown" | "auth-unavailable";
export interface Observation {
  quota: QuotaSnapshot | null;
  models: CatalogModel[];
  catalogAt: string | null;
  /** The Claude CLI's own model rows and when they were read. Display and
   * alias metadata only; eligibility stays keyed on `models` ids. */
  cliModels?: CliModel[];
  cliModelsAt?: string;
  attemptedAt: string | null;
  error: string | null;
  blocked?: "auth-unavailable" | "cooldown";
  cooldownUntil?: string;
}
export interface QuotaObserved { source: "inference" | "probe"; windows: QuotaWindow[]; requestId?: string | undefined }
export const emptyObservation = (): Observation => ({ quota: null, models: [], catalogAt: null, attemptedAt: null, error: null });
const snapshotOf = ({ cliModels: _cliModels, ...snapshot }: QuotaRead): QuotaSnapshot => snapshot;
const cliModelsFresh = (o: Observation, now: number): boolean =>
  !!o.cliModelsAt && now - Date.parse(o.cliModelsAt) < CLI_MODELS_FRESH_MS && now >= Date.parse(o.cliModelsAt);

/** Unknown scopes are never guessed to grant model access. */
export function windowScope(provider: Provider, bucket: string): "all" | "opus" | "sonnet" | "unknown" {
  if (provider === "codex") return /^codex:(primary|secondary)$/.test(bucket) ? "all" : "unknown";
  if (["five_hour", "seven_day", "seven_day_oauth_apps"].includes(bucket)) return "all";
  if (bucket === "seven_day_opus") return "opus";
  if (bucket === "seven_day_sonnet") return "sonnet";
  return "unknown";
}
function applies(provider: Provider, window: QuotaWindow, model: string): boolean {
  const scope = windowScope(provider, window.bucket);
  return scope === "all" || scope === "unknown" || !/^claude-(opus|sonnet|haiku)-/.test(model) || model.startsWith(`claude-${scope}-`);
}
export function applicableWindows(provider: Provider, observation: Observation, model: string): QuotaWindow[] {
  return observation.quota?.windows.filter(w => applies(provider, w, model)) ?? [];
}
export function selectionEvidence(provider: Provider, observation: Observation, model: string, reservations: number): SelectionEvidence {
  const windows = applicableWindows(provider, observation, model);
  const headroomPercent = windows.length && windows.every(w => w.remainingPercent !== null)
    ? Math.min(...windows.map(w => w.remainingPercent!)) : null;
  return { headroomPercent, limitingBuckets: headroomPercent === null ? [] : windows.filter(w => w.remainingPercent === headroomPercent).map(w => w.bucket).sort(),
    reservations, catalogAt: observation.catalogAt, quotaAt: observation.quota?.observedAt ?? null };
}
/** Input is already eligible and in cursor order; stable ties preserve that order. */
export function rankCandidates(policy: PoolPolicy, candidates: { accountId: string; evidence: SelectionEvidence }[]) {
  return [...candidates].sort((a, b) => a.evidence.reservations - b.evidence.reservations ||
    (policy === "most-remaining" ? (b.evidence.headroomPercent ?? -1) - (a.evidence.headroomPercent ?? -1) : 0));
}
export function eligibility(provider: Provider, enabled: boolean, model: string | undefined, observation: Observation, automatic: boolean, now = Date.now()): EligibilityReason {
  if (!enabled) return "disabled";
  if (observation.blocked) return observation.blocked;
  if (!model) return "model-required";
  if (!observation.catalogAt) return "catalog-unknown";
  if (now - Date.parse(observation.catalogAt) >= CATALOG_FRESH_MS || now < Date.parse(observation.catalogAt)) return "catalog-stale";
  if (!observation.models.some((m) => m.id === model)) return "model-unavailable";
  const quota = observation.quota;
  const windows = applicableWindows(provider, observation, model);
  // Known rejection is retained even when freshness expires; only new evidence clears it.
  if (windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0)) return "exhausted";
  if (!automatic) return "eligible";
  if (!quota || observation.error || !windows.length || windows.some((w) => w.remainingPercent === null)) return "quota-unknown";
  if (now - Date.parse(quota.observedAt) >= QUOTA_FRESH_MS || now < Date.parse(quota.observedAt)) return "quota-stale";
  if (windows.some((w) => windowScope(provider, w.bucket) === "unknown" || (provider === "claude" && ["opus", "sonnet"].includes(windowScope(provider, w.bucket)) && !/^claude-(opus|sonnet|haiku)-/.test(model)))) return "scope-unknown";
  // A window with no recorded use and no reset time has not started yet; its
  // full headroom is observed, not inferred from a passed reset.
  if (windows.some((w) => w.resetsAt ? Date.parse(w.resetsAt) <= now : w.usedPercent !== 0)) return "reset-unverified";
  return "eligible";
}

/** Bounded, demand-owned observations; no timers, persistence or background work. */
export class PoolEvidence {
  /** Called when an account's quota observation changes. `observed` holds only
   * the windows this read reported; the observation carries merged state. */
  onQuota?: (id: string, observation: Observation, observed: QuotaObserved) => void;
  private readonly generations = new Map<string, number>();
  invalidate(id: string): void { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.values.delete(id); this.retryAt.delete(id); this.cliRetryAt.delete(id); }
  private readonly values = new Map<string, Observation>();
  private readonly jobs = new Map<string, Promise<Observation>>();
  active(): number { return this.jobs.size; }
  private readonly retryAt = new Map<string, number>();
  private readonly catalog: (id: string) => Promise<CatalogModel[]>;
  private readonly quota: (id: string) => Promise<QuotaRead>;
  constructor(catalog: (id: string) => Promise<CatalogModel[]>, quota: (id: string) => Promise<QuotaRead>) { this.catalog = catalog; this.quota = quota; }
  reject(id: string, status: number, retryAfter?: string): void {
    if (![401, 403, 429].includes(status)) return;
    const seconds = retryAfter && /^\d{1,6}$/.test(retryAfter) ? Math.min(Number(retryAfter), 3600) : 60;
    this.values.set(id, { ...this.get(id), blocked: status === 429 ? "cooldown" : "auth-unavailable", cooldownUntil: new Date(Date.now() + seconds * 1000).toISOString() });
  }
  get(id: string): Observation { return this.values.get(id) ?? emptyObservation(); }
  /**
   * Record the quota windows a successful proxied response carried. Buckets
   * the headers do not report keep their last probed values, so Claude's
   * model-family weeklies survive; a 2xx also clears an earlier rejection and
   * a failed quota probe, since the credential has just worked. Catalog
   * failures are untouched: a response proves nothing about the catalog.
   */
  observe(id: string, provider: Provider, headers: ResponseHeaders, now = Date.now(), requestId?: string): boolean {
    const windows = normalizeResponseHeaderQuotas(provider, headers, now);
    if (!windows.length) return false;
    const { blocked: _blocked, cooldownUntil: _cooldownUntil, ...previous } = this.get(id);
    const carried = previous.quota?.windows.filter(w => !windows.some(n => n.bucket === w.bucket)) ?? [];
    this.values.set(id, { ...previous,
      quota: { accountId: id, provider, observedAt: new Date(now).toISOString(), status: "ok", windows: [...windows, ...carried], source: "inference" },
      error: previous.error === QUOTA_REFRESH_UNAVAILABLE ? null : previous.error });
    this.onQuota?.(id, this.get(id), { source: "inference", windows, requestId });
    return true;
  }
  setCatalog(id: string, models: CatalogModel[]): void {
    this.values.set(id, { ...this.get(id), models, catalogAt: new Date(Date.now()).toISOString() });
  }
  needsRefresh(provider: Provider, model: string, id: string, now = Date.now()): boolean {
    const o = this.get(id);
    if (o.blocked && Date.parse(o.cooldownUntil ?? "") > now) return false;
    const reason = eligibility(provider, true, model, o, true, now);
    return !!o.blocked || !!o.error || !o.catalogAt || now - Date.parse(o.catalogAt) >= CATALOG_FRESH_MS || now < Date.parse(o.catalogAt) ||
      !o.quota || now - Date.parse(o.quota.observedAt) >= QUOTA_FRESH_MS || now < Date.parse(o.quota.observedAt) ||
      applicableWindows(provider, o, model).some(w => !!w.resetsAt && Date.parse(w.resetsAt) <= now) ||
      ["quota-unknown", "reset-unverified"].includes(reason);
  }
  /** Demand-owned queue: at most four account reads globally, no retry loop/polling.
   * Aborting a waiter leaves shared reads to finish within their provider deadlines. */
  async refreshAdmission(ids: string[], provider: Provider, model: string, signal: AbortSignal, allowed: (id: string) => boolean): Promise<void> {
    const wait = async (job: Promise<unknown>) => {
      signal.throwIfAborted();
      let abort!: () => void;
      try {
        await Promise.race([job, new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        })]);
      } finally { signal.removeEventListener("abort", abort); }
    };
    const queue = [...new Set(ids)].slice(0, 16);
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        signal.throwIfAborted();
        if (!allowed(id) || !this.needsRefresh(provider, model, id)) continue;
        while (!this.jobs.has(id) && this.jobs.size >= 4) {
          await wait(Promise.race([...this.jobs.values()].map(job => job.catch(() => undefined))));
          signal.throwIfAborted();
        }
        if (allowed(id) && this.needsRefresh(provider, model, id)) await wait(this.refresh(id).catch(() => undefined));
      }
    }));
  }
  private readonly discoveries = new Map<string, Promise<void>>();
  private readonly discoveryRetryAt = new Map<string, number>();
  private readonly cliReads = new Map<string, Promise<void>>();
  private readonly cliRetryAt = new Map<string, number>();
  /**
   * Catalog discovery with no idle work. For Claude it also reads the CLI's
   * model rows when they are missing or older than CLI_MODELS_FRESH_MS; that
   * read is the usage probe, so its quota is recorded too.
   */
  async discover(ids: string[], signal: AbortSignal, allowed: (id: string) => boolean, provider?: Provider): Promise<void> {
    const queue = [...new Set(ids)].slice(0, 256);
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        signal.throwIfAborted();
        if (!allowed(id)) continue;
        const before = this.get(id), now = Date.now();
        if (before.blocked && Date.parse(before.cooldownUntil ?? "") > now) continue;
        const jobs: Promise<void>[] = [];
        const catalogFresh = before.catalogAt && now - Date.parse(before.catalogAt) < CATALOG_FRESH_MS && now >= Date.parse(before.catalogAt);
        if (!catalogFresh && (this.discoveryRetryAt.get(id) ?? 0) <= now) jobs.push(this.discoverCatalog(id));
        if (provider === "claude" && !cliModelsFresh(before, now) && (this.cliRetryAt.get(id) ?? 0) <= now) jobs.push(this.discoverCliModels(id));
        if (!jobs.length) continue;
        let abort!: () => void;
        try { await Promise.race([Promise.all(jobs), new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        })]); } finally { signal.removeEventListener("abort", abort); }
      }
    }));
  }
  private discoverCatalog(id: string): Promise<void> {
    let job = this.discoveries.get(id);
    if (!job) {
      const generation = this.generations.get(id);
      job = this.catalog(id).then(models => {
        if (generation === this.generations.get(id)) this.setCatalog(id, models);
      }).catch(() => { this.discoveryRetryAt.set(id, Date.now() + 5_000); })
        .finally(() => this.discoveries.delete(id));
      this.discoveries.set(id, job);
    }
    return job;
  }
  private discoverCliModels(id: string): Promise<void> {
    let job = this.cliReads.get(id);
    if (!job) {
      const generation = this.generations.get(id);
      job = this.quota(id).then(read => {
        if (generation !== this.generations.get(id)) return;
        const previous = this.get(id), snapshot = snapshotOf(read), ok = snapshot.status === "ok";
        this.values.set(id, { ...previous,
          ...(ok ? { quota: { ...snapshot, source: "probe" }, error: previous.error === QUOTA_REFRESH_UNAVAILABLE ? null : previous.error } : {}),
          ...(read.cliModels ? { cliModels: read.cliModels, cliModelsAt: new Date(Date.now()).toISOString() } : {}) });
        if (ok) this.onQuota?.(id, this.get(id), { source: "probe", windows: snapshot.windows });
        if (!read.cliModels) this.cliRetryAt.set(id, Date.now() + CLI_MODELS_RETRY_MS);
      }).catch(() => { this.cliRetryAt.set(id, Date.now() + CLI_MODELS_RETRY_MS); })
        .finally(() => this.cliReads.delete(id));
      this.cliReads.set(id, job);
    }
    return job;
  }
  refresh(id: string): Promise<Observation> {
    const pending = this.jobs.get(id);
    if (pending) return pending;
    if (this.jobs.size >= 4) return Promise.reject(new Error("quota refresh busy"));
    if ((this.retryAt.get(id) ?? 0) > Date.now()) return Promise.resolve(this.get(id));
    const before = this.get(id), generation = this.generations.get(id);
    const job = (async () => {
      const [catalog, quota] = await Promise.allSettled([this.catalog(id), this.quota(id)]);
      if (generation !== this.generations.get(id)) return this.get(id);
      const previous = this.get(id), attemptedAt = new Date(Date.now()).toISOString();
      const snapshot = quota.status === "fulfilled" && quota.value.status === "ok" ? snapshotOf(quota.value) : null;
      const cliModels = quota.status === "fulfilled" ? quota.value.cliModels : undefined;
      const error = catalog.status === "rejected" ? "Account catalog unavailable" : !snapshot ? QUOTA_REFRESH_UNAVAILABLE : null;
      const result: Observation = {
        quota: snapshot ? { ...snapshot, source: "probe" } : previous.quota,
        models: catalog.status === "fulfilled" ? catalog.value : previous.models,
        catalogAt: catalog.status === "fulfilled" ? attemptedAt : null,
        attemptedAt, error,
        ...(cliModels ? { cliModels, cliModelsAt: attemptedAt } : previous.cliModels ? { cliModels: previous.cliModels, cliModelsAt: previous.cliModelsAt! } : {}),
        ...(previous.blocked && (previous !== before || error || Date.parse(previous.cooldownUntil!) > Date.now()) ? { blocked: previous.blocked, cooldownUntil: previous.cooldownUntil } : {}),
      };
      this.values.set(id, result);
      if (snapshot) this.onQuota?.(id, result, { source: "probe", windows: snapshot.windows });
      const retry = quota.status === "fulfilled" ? quota.value.retryAfterSeconds : undefined;
      this.retryAt.set(id, Date.now() + (error ? Math.max(5, Math.min(retry ?? 5, 3600)) * 1000 : 1000));
      return result;
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
}
