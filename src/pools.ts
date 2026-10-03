// Pool observations are metadata only. Reading an overview never runs a provider.
import type { CatalogModel } from "./control.ts";
import type { QuotaSnapshot, QuotaWindow } from "./quotas.ts";
import type { Provider } from "./types.ts";

export type PoolPolicy = "manual" | "round-robin";
export interface Pool {
  id: string; integrationId: string; name: string; provider: Provider;
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
export function eligibility(provider: Provider, enabled: boolean, model: string | undefined, observation: Observation, automatic: boolean, now = Date.now()): EligibilityReason {
  if (!enabled) return "disabled";
  if (observation.blocked) return observation.blocked;
  if (!model) return "model-required";
  if (!observation.catalogAt) return "catalog-unknown";
  if (now - Date.parse(observation.catalogAt) >= CATALOG_FRESH_MS || now < Date.parse(observation.catalogAt)) return "catalog-stale";
  if (!observation.models.some((m) => m.id === model)) return "model-unavailable";
  const quota = observation.quota;
  const windows = quota?.windows.filter((w) => applies(provider, w, model)) ?? [];
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
  private readonly values = new Map<string, Observation>();
  private readonly jobs = new Map<string, Promise<Observation>>();
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
  refresh(id: string): Promise<Observation> {
    const pending = this.jobs.get(id);
    if (pending) return pending;
    if (this.jobs.size >= 4) return Promise.reject(new Error("quota refresh busy"));
    if ((this.retryAt.get(id) ?? 0) > Date.now()) return Promise.resolve(this.get(id));
    const before = this.get(id);
    const job = (async () => {
      const [catalog, quota] = await Promise.allSettled([this.catalog(id), this.quota(id)]);
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
