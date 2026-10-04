// Pool observations are metadata only. Reading an overview never runs a provider.
import type { CatalogModel } from "./control.ts";
import type { QuotaSnapshot, QuotaWindow } from "./quotas.ts";
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
export const CATALOG_FRESH_MS = 60_000;
export type EligibilityReason = "eligible" | "disabled" | "model-required" | "catalog-unknown" | "catalog-stale" | "model-unavailable" | "quota-unknown" | "quota-stale" | "scope-unknown" | "exhausted" | "reset-unverified" | "cooldown" | "auth-unavailable";
export interface Observation {
  quota: QuotaSnapshot | null;
  models: CatalogModel[];
  catalogAt: string | null;
  attemptedAt: string | null;
  error: string | null;
  blocked?: "auth-unavailable" | "cooldown";
  cooldownUntil?: string;
}
export const emptyObservation = (): Observation => ({ quota: null, models: [], catalogAt: null, attemptedAt: null, error: null });

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
  if (windows.some((w) => !w.resetsAt || Date.parse(w.resetsAt) <= now)) return "reset-unverified";
  return "eligible";
}

/** Bounded, demand-owned observations; no timers, persistence or background work. */
export class PoolEvidence {
  private readonly generations = new Map<string, number>();
  invalidate(id: string): void { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.values.delete(id); this.retryAt.delete(id); }
  private readonly values = new Map<string, Observation>();
  private readonly jobs = new Map<string, Promise<Observation>>();
  active(): number { return this.jobs.size; }
  private readonly retryAt = new Map<string, number>();
  private readonly catalog: (id: string) => Promise<CatalogModel[]>;
  private readonly quota: (id: string) => Promise<QuotaSnapshot>;
  constructor(catalog: (id: string) => Promise<CatalogModel[]>, quota: (id: string) => Promise<QuotaSnapshot>) { this.catalog = catalog; this.quota = quota; }
  reject(id: string, status: number, retryAfter?: string): void {
    if (![401, 403, 429].includes(status)) return;
    const seconds = retryAfter && /^\d{1,6}$/.test(retryAfter) ? Math.min(Number(retryAfter), 3600) : 60;
    this.values.set(id, { ...this.get(id), blocked: status === 429 ? "cooldown" : "auth-unavailable", cooldownUntil: new Date(Date.now() + seconds * 1000).toISOString() });
  }
  get(id: string): Observation { return this.values.get(id) ?? emptyObservation(); }
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
      const snapshot = quota.status === "fulfilled" && quota.value.status === "ok" ? quota.value : null;
      const error = catalog.status === "rejected" ? "Account catalog unavailable" : !snapshot ? "Quota refresh unavailable" : null;
      const result: Observation = {
        quota: snapshot ?? previous.quota,
        models: catalog.status === "fulfilled" ? catalog.value : previous.models,
        catalogAt: catalog.status === "fulfilled" ? attemptedAt : null,
        attemptedAt, error,
        ...(previous.blocked && (previous !== before || error || Date.parse(previous.cooldownUntil!) > Date.now()) ? { blocked: previous.blocked, cooldownUntil: previous.cooldownUntil } : {}),
      };
      this.values.set(id, result);
      const retry = quota.status === "fulfilled" ? quota.value.retryAfterSeconds : undefined;
      this.retryAt.set(id, Date.now() + (error ? Math.max(5, Math.min(retry ?? 5, 3600)) * 1000 : 1000));
      return result;
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
}
