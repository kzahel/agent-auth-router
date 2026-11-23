// On-demand, metadata-only quota reads. OAuth remains owned by official CLIs.
import { realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliModel } from "./contract.ts";
import { callCloudCodeWithCoordinator, normalizeAntigravityQuotas, postCloudCode } from "./antigravity-cloudcode.ts";
import { CredentialUnavailable, type CredentialCoordinator } from "./coordinator.ts";
import { credentialReaderFor } from "./credentials.ts";
import { directProviderProblem, probeClaudeCli } from "./helpers.ts";
import { log, sanitize } from "./log.ts";
import { providerExecutable } from "./platform.ts";
import { helperEnv, startBounded } from "./process.ts";
import { ADAPTERS } from "./providers.ts";
import type { AccountConfig, Provider } from "./types.ts";

export interface QuotaWindow {
  bucket: string;
  windowMinutes: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface QuotaSnapshot {
  accountId: string; // Local enrollment id, not a provider account identifier.
  provider: Provider;
  observedAt: string;
  status: "ok" | "unavailable";
  windows: QuotaWindow[];
  /** Account-verified permission for included Codex usage, independent of rounded display percentages. */
  ordinaryUsageAllowed?: boolean;
  ordinaryUsageObservedAt?: string;
  planType?: string;
  /** Included allowance relative to the standard USD 200 plan; absent for unverified plans. */
  planCapacityUnits?: number;
  /** "probe" is an explicit or admission read; "inference" is passively
   * observed from a proxied response's rate-limit headers. Absent means probe. */
  source?: "probe" | "inference";
  error?: string;
  retryAfterSeconds?: number;
  /** Granted usage-limit resets; present only while the owner's limit-reset setting is on. */
  limitResets?: LimitResets;
}

/** One kind of granted usage-limit reset, as the provider describes it. */
export interface LimitReset {
  /** Provider display text, such as "Full reset"; null when absent. */
  label: string | null;
  /** Resets of this kind still unused. */
  available: number;
  /** Resets of this kind granted in total, when the provider says. */
  total: number | null;
  /** When the unused resets expire; null if they do not or it is unknown. */
  expiresAt: string | null;
  /** Whether the provider says one could be used now; null when it does not say. */
  usableNow: boolean | null;
}

/**
 * Usage-limit resets an account holds. Read only, never redeemed: the router
 * reports them and leaves using one to the owner. Claude's source is an
 * undocumented endpoint, so a failed read is recorded here and never fails
 * the quota read it accompanies.
 */
export interface LimitResets {
  observedAt: string;
  /** Unused resets of every kind; null when unknown. */
  available: number | null;
  resets: LimitReset[];
  /** Why the resets are unknown. */
  error?: string;
}

/** Lower-cased single header values; repeated headers keep the last value. */
export type ResponseHeaders = Record<string, string | string[] | undefined>;
function header(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name];
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof last === "string" && last.length <= 512 && !/[\x00-\x1f\x7f]/.test(last) ? last.trim() : undefined;
}
const finite = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Quota windows carried by a proxied inference response, or [] when the
 * response reports none. Anthropic's unified headers report utilization as a
 * fraction and resets as epoch seconds; Codex reports used percentages and a
 * relative or absolute reset. Only the shared windows travel this way, so a
 * probe remains the source for Claude's model-family weeklies.
 */
export function normalizeResponseHeaderQuotas(provider: Provider, headers: ResponseHeaders, now = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (provider === "claude") {
    for (const [bucket, prefix, minutes] of [["five_hour", "anthropic-ratelimit-unified-5h", 300], ["seven_day", "anthropic-ratelimit-unified-7d", 10080]] as const) {
      const fraction = finite(header(headers, `${prefix}-utilization`));
      if (fraction === undefined) continue;
      const reset = finite(header(headers, `${prefix}-reset`));
      windows.push(window(bucket, minutes, Math.min(100, fraction * 100), reset === undefined ? null : iso(reset, true)));
    }
    return windows;
  }
  if (provider !== "codex") return windows;
  for (const kind of ["primary", "secondary"] as const) {
    const used = finite(header(headers, `x-codex-${kind}-used-percent`));
    if (used === undefined) continue;
    const after = finite(header(headers, `x-codex-${kind}-reset-after-seconds`));
    const at = header(headers, `x-codex-${kind}-reset-at`);
    const resetsAt = after !== undefined && after >= 0 ? new Date(now + after * 1000).toISOString()
      : at !== undefined ? (iso(finite(at), true) ?? iso(at)) : null;
    windows.push(window(`codex:${kind}`, finite(header(headers, `x-codex-${kind}-window-minutes`)) ?? null, Math.min(100, used), resetsAt));
  }
  return windows;
}

/** Dependency overrides for synthetic tests; not exposed in account config. */
export interface QuotaReadOptions {
  timeoutMs?: number;
  codexCommand?: string;
  codexArgs?: string[];
  claudeCommand?: string;
  claudeArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Also read granted limit resets: the owner's setting, decided per read. */
  limitResets?: boolean;
  /** Origin for the Claude limit-reset read; tests point it at a local server. */
  claudeOrigin?: string;
  /** The CLI whose `--version` names the limit-reset read's User-Agent; default `claude` on PATH. */
  claudeVersionCommand?: string;
  claudeVersionArgs?: string[];
  /** Origin for Antigravity quota reads; tests point it at a local mock upstream. */
  antigravityOrigin?: string;
  /** Coordinator for Antigravity accounts so expired tokens renew via the official CLI. */
  coordinator?: CredentialCoordinator;
}

const MAX_BYTES = 256 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function iso(value: unknown, seconds = false): string | null {
  const ms = seconds ? (typeof value === "number" ? value * 1000 : NaN)
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

// Header fractions scaled to percent carry float noise (0.57 * 100 is
// 56.99999999999999); a tenth of a percent is ample for display and ranking.
const tenth = (value: number) => Math.round(value * 10) / 10;

// November 2026 included Codex allowances: Plus 1x, Pro 100 10x, Pro 200 20x.
export function codexPlanCapacityUnits(plan: unknown): number | undefined {
  return plan === "plus" ? 0.05 : plan === "prolite" ? 0.5 : plan === "pro" ? 1 : undefined;
}

/** Remaining allowance in USD 200 plan units, never inferred from permission alone. */
export function remainingCapacityUnits(quota: QuotaSnapshot, w: QuotaWindow): number | null {
  if (quota.planCapacityUnits === undefined || w.remainingPercent === null ||
    (quota.ordinaryUsageAllowed === true && w.remainingPercent === 0)) return null;
  return Math.round(quota.planCapacityUnits * w.remainingPercent * 100) / 10_000;
}

function window(bucket: string, minutes: number | null, used: unknown, resetsAt: string | null): QuotaWindow {
  const raw = nonnegative(used);
  const usedPercent = raw === null ? null : tenth(raw);
  return { bucket, windowMinutes: minutes, usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, tenth(100 - usedPercent)), resetsAt };
}

export function normalizeCodexQuotas(value: unknown): QuotaWindow[] {
  const result = object(value);
  if (!result) return [];
  const byId = object(result.rateLimitsByLimitId);
  const legacy = object(result.rateLimits);
  const rows = byId && Object.keys(byId).length ? Object.entries(byId)
    : legacy ? [[typeof legacy.limitId === "string" ? legacy.limitId : "codex", legacy] as const] : [];
  const windows: QuotaWindow[] = [];
  for (const [id, row] of rows.slice(0, 64)) {
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(id)) continue;
    const snapshot = object(row);
    for (const kind of ["primary", "secondary"] as const) {
      const data = object(snapshot?.[kind]);
      if (data) windows.push(window(`${id}:${kind}`, nonnegative(data.windowDurationMins), data.usedPercent, iso(data.resetsAt, true)));
    }
  }
  return windows;
}

// The CLI's `get_usage` rate_limits (the OAuth usage JSON) use percentages
// (0..100), unlike inference response headers whose utilization is a
// fraction (0..1). Never interchange them.
export function normalizeClaudeQuotas(value: unknown): QuotaWindow[] {
  const result = object(value);
  if (!result) return [];
  const windows: QuotaWindow[] = [];
  for (const bucket of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]) {
    const data = object(result[bucket]);
    if (data) windows.push(window(bucket, bucket === "five_hour" ? 300 : 10080, data.utilization, iso(data.resets_at)));
  }
  for (const [bucket, value] of Object.entries(result).slice(0, 64)) {
    // extra_usage meters paid overage credits, not a rate-limit window. The
    // router never enables overage, so it is neither headroom nor a limit.
    if (bucket === "extra_usage" || windows.some(w => w.bucket === bucket) || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(bucket)) continue;
    const data = object(value);
    if (data && "utilization" in data) windows.push(window(bucket, null, data.utilization, iso(data.resets_at)));
  }
  return windows;
}

const MAX_RESET_ROWS = 32;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value: unknown): string | null =>
  typeof value === "string" && /^[^\x00-\x1f\x7f]{1,160}$/.test(value.trim()) ? value.trim() : null;

/** Resets of the same label and expiry form one row, so a list of single credits reads as counts. */
function limitResets(observedAt: string, rows: LimitReset[], available: number | null): LimitResets {
  const merged: LimitReset[] = [];
  for (const row of rows) {
    const same = merged.find(m => m.label === row.label && m.expiresAt === row.expiresAt && m.usableNow === row.usableNow);
    if (!same) merged.push({ ...row });
    else {
      same.available += row.available;
      same.total = same.total !== null && row.total !== null ? same.total + row.total : null;
    }
  }
  // Soonest expiry first; resets without one last.
  const expiry = (r: LimitReset) => r.expiresAt === null ? Infinity : Date.parse(r.expiresAt);
  merged.sort((a, b) => (expiry(a) - expiry(b)) || 0);
  return { observedAt, available: available ?? merged.reduce((sum, r) => sum + r.available, 0), resets: merged };
}

const resetsUnknown = (observedAt: string, error: string): LimitResets => ({ observedAt, available: null, resets: [], error });

/**
 * Codex app-server's `rateLimitResetCredits`, from the same
 * `account/rateLimits/read` answer as the windows: an available count and
 * per-credit rows with epoch-second expiry. The list may be capped below the
 * count, so the count is kept as reported.
 */
export function normalizeCodexLimitResets(value: unknown, observedAt = new Date().toISOString()): LimitResets {
  const summary = object(object(value)?.rateLimitResetCredits);
  if (!summary) return resetsUnknown(observedAt, "Codex did not report limit resets");
  const rows = (Array.isArray(summary.credits) ? summary.credits : []).slice(0, MAX_RESET_ROWS).flatMap((item): LimitReset[] => {
    const credit = object(item);
    if (!credit || (credit.status !== undefined && credit.status !== "available")) return [];
    const expires = credit.expiresAt === null ? null : iso(credit.expiresAt, true);
    return [{ label: label(credit.title), available: 1, total: null, expiresAt: expires, usableNow: null }];
  });
  return limitResets(observedAt, rows, count(summary.availableCount));
}

/**
 * The `cedar_ember` block of Claude's `/api/oauth/usage?cedar_ember=1`, as
 * Claude Code 2.1.322 reads it: grants with a label, resets left and total,
 * an `ends_at` expiry and whether one is usable now. Undocumented and
 * experiment-named, so every field is optional and anything else is ignored.
 */
export function normalizeClaudeLimitResets(value: unknown, observedAt = new Date().toISOString()): LimitResets {
  const status = object(object(value)?.cedar_ember);
  if (!status) return resetsUnknown(observedAt, "Claude did not report limit resets");
  // Ineligible means "not shown to this caller", not "none held": claude.ai can list
  // grants that the same account's read here reports as ineligible for its surface.
  if (status.eligible === false) {
    const reason = label(status.ineligible_reason);
    return resetsUnknown(observedAt, `Claude does not report limit resets to the router${reason && /^[a-z_]{1,40}$/.test(reason) ? ` (ineligible: ${reason})` : ""}`);
  }
  const rows = (Array.isArray(status.grants) ? status.grants : []).slice(0, MAX_RESET_ROWS).flatMap((item): LimitReset[] => {
    const grant = object(item);
    const left = count(grant?.resets_left);
    if (!grant || !left) return [];
    const usable = typeof grant.usable_now === "boolean" ? grant.usable_now && grant.paused !== true : null;
    return [{ label: label(grant.label), available: left, total: count(grant.resets_total), expiresAt: iso(grant.ends_at), usableNow: usable }];
  });
  return limitResets(observedAt, rows, null);
}

const LIMIT_RESET_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";

const VERSION_RETRY_MS = 5 * 60_000;
const cliVersions = new Map<string, { version: Promise<string | null>; at: number }>();

/**
 * An installed CLI's version from `--version`, cached per resolved binary:
 * an update installs a new file, which is read once on its next use.
 * Concurrent callers share one read; a failed read is retried after five minutes.
 */
export async function cliVersion(command: string, args: string[] = ["--version"], now = Date.now()): Promise<string | null> {
  let key = command;
  try { key = realpathSync(command); } catch { /* A bare name or missing file keys by name. */ }
  key = `${key}\0${args.join("\0")}`;
  const cached = cliVersions.get(key);
  if (cached) {
    const version = await cached.version;
    if (version !== null || now - cached.at < VERSION_RETRY_MS) return version;
  }
  const version = readCliVersion(command, args);
  cliVersions.set(key, { version, at: now });
  return version;
}

async function readCliVersion(command: string, args: string[]): Promise<string | null> {
  try {
    // --version gets an isolated, empty profile location without creating it.
    const probe = startBounded({ command, args, env: helperEnv("claude", join(tmpdir(), `aar-version-${process.pid}-claude`)),
      cwd: tmpdir(), timeoutMs: 3000, maxStderrBytes: 0, killGraceMs: 100 });
    let output = "";
    probe.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString().slice(0, Math.max(0, 256 - output.length)); });
    probe.child.stdin?.end();
    const result = await probe.done;
    return result.code === 0 && !result.timedOut ? /^\s*(\d{1,4}\.\d{1,4}\.\d{1,6})(?:\s|$)/.exec(output)?.[1] ?? null : null;
  } catch { return null; }
}

/**
 * Claude reports grants only to its interactive CLI, which it tells apart by
 * User-Agent: `claude-cli/<version> (external, cli)`. Observed 2026-11-16, the
 * SDK's `sdk-ts` entrypoint, no entrypoint or another client name was
 * ineligible ("surface"), and version 2.0.0 was too old ("cli_version").
 * The version is that of the `claude` on PATH, the CLI that owns the login.
 */
async function claudeUserAgent(options: QuotaReadOptions): Promise<string | null> {
  const version = await cliVersion(options.claudeVersionCommand ?? providerExecutable("claude"), options.claudeVersionArgs);
  return version ? `claude-cli/${version} (external, cli)` : null;
}

/**
 * Claude's granted limit resets, read with the profile's current access token
 * after the CLI's usage read has renewed it. The router never renews or
 * redeems here. Every failure becomes `error`; nothing is retried.
 */
async function claudeLimitResets(account: AccountConfig, options: QuotaReadOptions): Promise<LimitResets> {
  const observedAt = () => new Date().toISOString();
  try {
    const credential = await credentialReaderFor("claude", account.home, account.credentialStore)();
    if (credential.status !== "ok") return resetsUnknown(observedAt(), "no usable Claude access token for the limit-reset read");
    const userAgent = await claudeUserAgent(options);
    if (!userAgent) return resetsUnknown(observedAt(), "could not read the installed Claude CLI version");
    const response = await getJson(options.claudeOrigin ?? "https://api.anthropic.com", LIMIT_RESET_PATH, {
      authorization: `Bearer ${credential.credential.accessToken}`, accept: "application/json", "user-agent": userAgent,
      "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }, Math.min(options.timeoutMs ?? 10_000, 10_000));
    return "error" in response ? resetsUnknown(observedAt(), response.error) : normalizeClaudeLimitResets(response.value, observedAt());
  } catch {
    return resetsUnknown(observedAt(), "limit-reset read failed");
  }
}

/** One bounded GET: no redirects, retries or retained error bodies. */
function getJson(origin: string, path: string, headers: http.OutgoingHttpHeaders, timeoutMs: number): Promise<ReadResponse> {
  let url: URL;
  try {
    const base = new URL(origin);
    if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      !(base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)))) {
      return Promise.resolve({ error: "invalid limit-reset endpoint" });
    }
    url = new URL(path, base);
  } catch { return Promise.resolve({ error: "invalid limit-reset endpoint" }); }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ReadResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(result);
    };
    const request = (url.protocol === "https:" ? https : http).request(url, { method: "GET", headers }, (response) => {
      const code = response.statusCode ?? 0;
      if (code !== 200) {
        finish({ error: code === 401 || code === 403 ? "limit-reset read denied"
          : code === 404 ? "limit-reset read not offered by the provider"
          : code === 429 ? "limit-reset read rate limited" : `limit-reset read returned HTTP ${code}` });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) finish({ error: "limit-reset response exceeded size bound" });
        else chunks.push(chunk);
      });
      response.on("error", () => finish({ error: "limit-reset response interrupted" }));
      response.on("end", () => {
        try { finish({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { finish({ error: "limit-reset response is not valid JSON" }); }
      });
    });
    const deadline = setTimeout(() => finish({ error: "limit-reset read timed out" }), timeoutMs);
    request.on("error", () => finish({ error: "limit-reset read failed" }));
    request.end();
  });
}

type ReadResponse = { value: unknown } | { error: string; retryAfterSeconds?: number };

async function codexUsage(account: AccountConfig, workDir: string, options: QuotaReadOptions): Promise<ReadResponse> {
  if (await directProviderProblem({ account, workDir })) return { error: "profile overrides the provider endpoint" };
  const proc = startBounded({ command: options.codexCommand ?? "codex", args: options.codexArgs ?? ["app-server"],
    env: helperEnv("codex", account.home, options.env), cwd: workDir,
    timeoutMs: options.timeoutMs ?? 15_000, maxStderrBytes: 2048, killGraceMs: 100 });
  const { child } = proc;
  child.stdin?.on("error", () => {});
  const send = (message: unknown) => { if (child.stdin?.writable) child.stdin.write(JSON.stringify(message) + "\n"); };
  const pending = new Map<number, (message: Record<string, unknown> | undefined) => void>();
  let buffer = "";
  let protocolError: string | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (protocolError) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BYTES) {
      protocolError = "app-server response exceeded size bound";
      buffer = "";
      proc.terminate();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown> | undefined;
      try { message = object(JSON.parse(line)); } catch { /* Invalid protocol data is never emitted. */ }
      if (!message) { protocolError = "invalid app-server response"; proc.terminate(); return; }
      if (typeof message.method === "string" && message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "unsupported request" } });
      } else if (typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  const request = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown> | undefined>((resolve) => {
    pending.set(id, resolve);
    proc.done.then(() => resolve(undefined));
    send({ id, method, params });
  });
  let response: ReadResponse = { error: "app-server quota read failed" };
  const initialized = await request(1, "initialize", { clientInfo: { name: "agent-auth-router", version: "0.0.0" } });
  if (initialized && !initialized.error) {
    send({ method: "initialized" });
    // No account/read refreshToken request, no model session, no inference.
    const read = await request(2, "account/rateLimits/read", {});
    if (read && !read.error) response = { value: read.result };
  }
  child.stdin?.end();
  // A complete read is kept when only our own shutdown grace stopped the
  // process: a fresh profile can take longer than this to exit.
  let shutdownKilled = false;
  const grace = setTimeout(() => { shutdownKilled = true; proc.terminate(); }, 1000);
  const exit = await proc.done;
  clearTimeout(grace);
  const failed = (error: string): ReadResponse => {
    log("quota.codex_read_failed", { account: account.id, error, code: exit.code, signal: exit.signal,
      stderr: exit.stderrTail.slice(-280) || undefined });
    return { error };
  };
  if (protocolError) return failed(protocolError);
  if (exit.timedOut) return failed("app-server quota read timed out");
  if ("value" in response && (exit.code === 0 || shutdownKilled)) return response;
  if (exit.code === 0 && "error" in response) return failed(response.error);
  // A crashed app-server is diagnosed from its last stderr line, shown to
  // owners and integrations, so it is scrubbed of secrets and paths.
  const how = exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code}`;
  const excerpt = stderrExcerpt(exit.stderrTail);
  return failed(`app-server quota process failed (${how})${excerpt ? `: ${excerpt}` : ""}`);
}

/** The last non-empty stderr line, without secrets, paths or long text. */
export function stderrExcerpt(stderr: string): string {
  const line = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) ?? "";
  const scrubbed = sanitize(line.replace(/(?<=^|[\s"'`=(])(?:~|\.{1,2})?\/[^\s"'`:,;)]*/g, "[path]"));
  return scrubbed.length > 160 ? `${scrubbed.slice(0, 160)}…` : scrubbed;
}

/** A quota read plus the model rows the Claude CLI reported during it. */
export type QuotaRead = QuotaSnapshot & { cliModels?: CliModel[] };

export async function fetchAccountQuotas(account: AccountConfig, workDir: string, options: QuotaReadOptions = {}): Promise<QuotaSnapshot> {
  const { cliModels: _cliModels, ...snapshot } = await readAccountQuotas(account, workDir, options);
  return snapshot;
}

export async function readAccountQuotas(account: AccountConfig, workDir: string, options: QuotaReadOptions = {}): Promise<QuotaRead> {
  const base = { accountId: account.id, provider: account.provider };
  const unavailable = (error: string, retryAfterSeconds?: number): QuotaSnapshot => ({ ...base,
    observedAt: new Date().toISOString(), status: "unavailable", windows: [], error,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
  if (account.enabled === false) return unavailable("account disabled");
  if (account.provider === "antigravity") {
    try {
      const origin = options.antigravityOrigin ?? ADAPTERS.antigravity.defaultOrigin;
      let response;
      if (options.coordinator) {
        response = await callCloudCodeWithCoordinator(options.coordinator, "retrieveUserQuotaSummary", origin, {
          timeoutMs: options.timeoutMs ?? 15_000,
        });
      } else {
        const credential = await credentialReaderFor("antigravity", account.home, account.credentialStore)();
        if (credential.status !== "ok") return unavailable("credential unavailable; check official CLI login");
        response = await postCloudCode(origin, "retrieveUserQuotaSummary", credential.credential.accessToken, {
          timeoutMs: options.timeoutMs ?? 15_000,
        });
      }
      if (!response.ok) return unavailable(response.error);
      const windows = normalizeAntigravityQuotas(response.value);
      if (!windows.length) return unavailable("provider returned no recognized quota windows");
      return { ...base, observedAt: new Date().toISOString(), status: "ok", windows };
    } catch (error) {
      if (error instanceof CredentialUnavailable) return unavailable(error.message);
      return unavailable("quota read failed");
    }
  }
  let cliModels: CliModel[] | undefined;
  const read = (snapshot: QuotaSnapshot): QuotaRead => cliModels ? { ...snapshot, cliModels } : snapshot;
  try {
    let response: ReadResponse;
    if (account.provider === "codex") response = await codexUsage(account, workDir, options);
    else {
      // A signed-out profile never starts the CLI. An expired access token
      // with a refresh token is fine: the CLI renews it before reading usage.
      const credential = await credentialReaderFor("claude", account.home, account.credentialStore)();
      if (credential.status === "signed_out") return unavailable(credential.reason);
      if (credential.status !== "ok") return unavailable("credential unavailable; check official CLI login");
      const helper = account.helper?.kind === "claude-cli" ? account.helper : undefined;
      const probe = await probeClaudeCli({ account, workDir, ...(options.env ? { env: options.env } : {}) }, {
        command: options.claudeCommand ?? helper?.command, args: options.claudeArgs ?? helper?.args, timeoutMs: options.timeoutMs ?? 30_000 });
      response = probe.outcome === "completed" ? { value: probe.rateLimits } : { error: probe.detail };
      cliModels = probe.cliModels;
    }
    if ("error" in response) return read(unavailable(response.error, response.retryAfterSeconds));
    const windows = account.provider === "codex" ? normalizeCodexQuotas(response.value) : normalizeClaudeQuotas(response.value);
    if (!windows.length) return read(unavailable("provider returned no recognized quota windows"));
    const codex = account.provider === "codex" ? object(response.value) : undefined;
    const general = object(object(codex?.rateLimitsByLimitId)?.codex) ?? object(codex?.rateLimits);
    const planType = general?.planType;
    const planCapacityUnits = codexPlanCapacityUnits(planType);
    let resets: LimitResets | undefined;
    if (options.limitResets) {
      try { resets = account.provider === "codex" ? normalizeCodexLimitResets(response.value) : await claudeLimitResets(account, options); }
      catch { resets = resetsUnknown(new Date().toISOString(), "limit-reset read failed"); }
    }
    return read({
      ...base, observedAt: new Date().toISOString(), status: "ok", windows,
      ...(typeof codex?.ordinaryUsageAllowed === "boolean" ? { ordinaryUsageAllowed: codex.ordinaryUsageAllowed, ordinaryUsageObservedAt: new Date().toISOString() } : {}),
      ...(planCapacityUnits !== undefined ? { planCapacityUnits } : {}),
      ...(typeof planType === "string" && /^[a-z_]{1,64}$/.test(planType) ? { planType } : {}),
      ...(resets ? { limitResets: resets } : {})
    });
  } catch {
    // Process/network/credential errors may contain private data. No raw errors.
    return read(unavailable("quota read failed"));
  }
}
