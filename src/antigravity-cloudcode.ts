// Cloud Code metadata reads for Antigravity accounts (catalog and quota summary).
// Sends only the account's access token to the configured Cloud Code origin;
// never runs inference and never logs or retains credentials.

import http from "node:http";
import https from "node:https";
import { EFFORT_LEVELS, type CatalogModel } from "./contract.ts";
import { CredentialUnavailable, type CredentialCoordinator } from "./coordinator.ts";
import { ADAPTERS, parseUpstreamOrigin } from "./providers.ts";
import type { QuotaWindow } from "./quotas.ts";

const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const QUOTA_MAX_BYTES = 256 * 1024;
const SUMMARY_WINDOW_MINS: Readonly<Record<string, number>> = { "5h": 300, weekly: 10_080 };

/** User-Agent required by Cloud Code personal-account metadata RPCs. */
export function antigravityUserAgent(platform = process.platform, arch = process.arch): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=963137146)`;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const tenth = (value: number) => Math.round(value * 10) / 10;

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

export type CloudCodeResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

/** One bounded JSON POST to a Cloud Code `/v1internal:<rpc>` endpoint. */
export function postCloudCode(
  origin: string,
  rpc: "fetchAvailableModels" | "retrieveUserQuotaSummary",
  accessToken: string,
  options: { timeoutMs?: number; maxBytes?: number; userAgent?: string } = {},
): Promise<CloudCodeResult> {
  const url = new URL(`/v1internal:${rpc}`, parseUpstreamOrigin(origin));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? QUOTA_MAX_BYTES;
  const body = Buffer.from("{}");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CloudCodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(result);
    };
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(body.length),
          "user-agent": options.userAgent ?? antigravityUserAgent(),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          finish({ ok: false, status, error: status === 401 || status === 403 ? "upstream denied request" : `upstream returned HTTP ${status}` });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) finish({ ok: false, status: 502, error: "response exceeded size bound" });
          else chunks.push(chunk);
        });
        response.on("error", () => finish({ ok: false, status: 502, error: "response interrupted" }));
        response.on("end", () => {
          try {
            finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            finish({ ok: false, status: 502, error: "invalid JSON response" });
          }
        });
      },
    );
    const deadline = setTimeout(() => finish({ ok: false, status: 504, error: "request timed out" }), timeoutMs);
    request.on("error", () => finish({ ok: false, status: 502, error: "upstream unavailable" }));
    request.end(body);
  });
}

/**
 * Calls a Cloud Code metadata RPC through `coordinator`, retrying once after
 * official-CLI credential recovery on HTTP 401.
 */
export async function callCloudCodeWithCoordinator(
  coordinator: CredentialCoordinator,
  rpc: "fetchAvailableModels" | "retrieveUserQuotaSummary",
  origin?: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<CloudCodeResult> {
  const targetOrigin = origin ?? ADAPTERS.antigravity.defaultOrigin;
  let credential = await coordinator.credential();
  let result = await postCloudCode(targetOrigin, rpc, credential.accessToken, options);
  if (!result.ok && result.status === 401) {
    const recovered = await coordinator.recoverFromUnauthorized(credential);
    if (recovered) {
      credential = recovered;
      result = await postCloudCode(targetOrigin, rpc, credential.accessToken, options);
    }
    if (!result.ok && result.status === 401) {
      coordinator.markRejected("upstream rejected the account credential", credential);
    }
  }
  return result;
}

/**
 * Normalizes `v1internal:fetchAvailableModels` into the concrete base model IDs
 * and effort levels `agy acp` accepts in `session/set_config_option`.
 */
export function parseAntigravityCatalog(value: unknown): CatalogModel[] | null {
  const root = object(value);
  const rawModels = object(root?.models);
  if (!rawModels) return null;

  const grouped = object(root?.groupedModels);
  const variantToGroup = new Map<string, { baseId: string; displayName: string; levels: { suffix: string; label: string }[] }>();
  if (grouped) {
    for (const [baseId, entry] of Object.entries(grouped)) {
      if (!baseId || baseId.length > 200) continue;
      const group = object(entry);
      if (!group) continue;
      const displayName = typeof group.displayName === "string" && group.displayName.trim() ? group.displayName.trim().slice(0, 200) : baseId;
      const rawLevels = Array.isArray(group.supportedThinkingLevels) ? group.supportedThinkingLevels : [];
      const levels: { suffix: string; label: string }[] = [];
      for (const item of rawLevels.slice(0, 16)) {
        const level = object(item);
        const suffix = typeof level?.thinkingSuffix === "string" ? level.thinkingSuffix : undefined;
        if (!suffix || !EFFORT_LEVELS.includes(suffix)) continue;
        const label = typeof level?.thinkingDisplayName === "string" ? level.thinkingDisplayName.slice(0, 100) : "";
        levels.push({ suffix, label });
      }
      if (!levels.length) continue;
      const info = { baseId, displayName, levels };
      for (const level of levels) variantToGroup.set(`${baseId}-${level.suffix}`, info);
    }
  }

  const orderedIds: string[] = [];
  const sorts = Array.isArray(root?.agentModelSorts) ? root.agentModelSorts : [];
  for (const sort of sorts) {
    const groups = Array.isArray(object(sort)?.groups) ? (object(sort)!.groups as unknown[]) : [];
    for (const group of groups) {
      const ids = Array.isArray(object(group)?.modelIds) ? (object(group)!.modelIds as unknown[]) : [];
      for (const id of ids) if (typeof id === "string" && id.length > 0 && id.length <= 200) orderedIds.push(id);
    }
  }
  const candidateIds = orderedIds.length
    ? orderedIds
    : Object.entries(rawModels)
        .filter(([, entry]) => {
          const m = object(entry);
          return m && m.disabled !== true && m.isInternal !== true && m.recommended !== false;
        })
        .map(([id]) => id);

  const defaultModelId = typeof root?.defaultAgentModelId === "string" ? root.defaultAgentModelId : undefined;
  const seen = new Set<string>();
  const result: CatalogModel[] = [];

  for (const id of candidateIds) {
    if (result.length >= 512) break;
    const row = object(rawModels[id]);
    if (!row || row.disabled === true || row.isInternal === true) continue;
    const group = variantToGroup.get(id);
    if (group) {
      if (seen.has(group.baseId)) continue;
      seen.add(group.baseId);
      const activeLevels = group.levels.filter((level) => {
        const variant = object(rawModels[`${group.baseId}-${level.suffix}`]);
        return variant && variant.disabled !== true && variant.isInternal !== true;
      });
      if (!activeLevels.length) continue;
      const maxTokens = row.maxTokens;
      const defaultSuffix = activeLevels.find((level) => `${group.baseId}-${level.suffix}` === defaultModelId)?.suffix;
      result.push({
        id: group.baseId,
        name: group.displayName,
        ...(Number.isSafeInteger(maxTokens) && (maxTokens as number) > 0 ? { contextWindow: maxTokens as number } : {}),
        supportsEffort: true,
        supportedReasoningEfforts: activeLevels.map((level) => ({ reasoningEffort: level.suffix, description: level.label })),
        ...(defaultSuffix ? { defaultReasoningEffort: defaultSuffix } : {}),
        capabilitySource: "provider",
      });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName.trim().slice(0, 200) : id;
    const maxTokens = row.maxTokens;
    result.push({
      id,
      name,
      ...(Number.isSafeInteger(maxTokens) && (maxTokens as number) > 0 ? { contextWindow: maxTokens as number } : {}),
      supportsEffort: false,
      supportsAdaptiveThinking: false,
      capabilitySource: "provider",
    });
  }
  return result;
}

export async function readAntigravityCatalog(coordinator: CredentialCoordinator, origin?: string): Promise<CatalogModel[]> {
  const response = await callCloudCodeWithCoordinator(coordinator, "fetchAvailableModels", origin, {
    timeoutMs: 15_000,
    maxBytes: CATALOG_MAX_BYTES,
  });
  if (!response.ok) {
    if (response.status === 401) throw new CredentialUnavailable("login_required", "upstream rejected the account credential");
    throw new Error(response.error);
  }
  const models = parseAntigravityCatalog(response.value);
  if (!models || !models.length) throw new Error("invalid Antigravity catalog");
  return models;
}

/**
 * Normalizes `v1internal:retrieveUserQuotaSummary` into AAR quota windows.
 * Untouched buckets report a rolling full-window reset; drop their `resetsAt`
 * so `weekly-pace` treats them as unstarted timers rather than ticking windows.
 */
export function normalizeAntigravityQuotas(value: unknown, now = Date.now()): QuotaWindow[] {
  const root = object(value);
  if (!root) return [];
  const rawGroups = Array.isArray(root.groups) ? root.groups : [];
  const buckets: unknown[] = [];
  for (const group of rawGroups) {
    const list = object(group)?.buckets;
    if (Array.isArray(list)) buckets.push(...list);
  }
  if (!buckets.length && Array.isArray(root.buckets)) buckets.push(...root.buckets);

  const seen = new Set<string>();
  const windows: QuotaWindow[] = [];
  for (const item of buckets.slice(0, 64)) {
    const bucket = object(item);
    const id = typeof bucket?.bucketId === "string" ? bucket.bucketId : undefined;
    if (!bucket || !id || seen.has(id) || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(id) || bucket.disabled === true) continue;
    const fraction = bucket.remainingFraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    seen.add(id);
    const windowMinutes = typeof bucket.window === "string" ? (SUMMARY_WINDOW_MINS[bucket.window] ?? null) : null;
    const resetIso = iso(bucket.resetTime);
    const untouched =
      fraction === 1 &&
      typeof bucket.description !== "string" &&
      windowMinutes !== null &&
      resetIso !== null &&
      Math.abs(Date.parse(resetIso) - now - windowMinutes * 60_000) <= 60_000;
    const usedPercent = tenth((1 - fraction) * 100);
    windows.push({
      bucket: id,
      windowMinutes,
      usedPercent,
      remainingPercent: Math.max(0, tenth(100 - usedPercent)),
      resetsAt: untouched ? null : resetIso,
    });
  }
  return windows;
}
