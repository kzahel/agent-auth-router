// On-demand, metadata-only quota reads. OAuth remains owned by official CLIs.
import { credentialReaderFor } from "./credentials.ts";
import { directProviderProblem, probeClaudeCli } from "./helpers.ts";
import { helperEnv, startBounded } from "./process.ts";
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
  /** "probe" is an explicit or admission read; "inference" is passively
   * observed from a proxied response's rate-limit headers. Absent means probe. */
  source?: "probe" | "inference";
  error?: string;
  retryAfterSeconds?: number;
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

function window(bucket: string, minutes: number | null, used: unknown, resetsAt: string | null): QuotaWindow {
  const usedPercent = nonnegative(used);
  return { bucket, windowMinutes: minutes, usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), resetsAt };
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

type ReadResponse = { value: unknown } | { error: string; retryAfterSeconds?: number };

async function codexUsage(account: AccountConfig, workDir: string, options: QuotaReadOptions): Promise<ReadResponse> {
  if (await directProviderProblem({ account, workDir })) return { error: "profile overrides the provider endpoint" };
  const proc = startBounded({ command: options.codexCommand ?? "codex", args: options.codexArgs ?? ["app-server"],
    env: helperEnv("codex", account.home, options.env), cwd: workDir,
    timeoutMs: options.timeoutMs ?? 15_000, maxStderrBytes: 0, killGraceMs: 100 });
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
  const grace = setTimeout(() => proc.terminate(), 1000);
  const exit = await proc.done;
  clearTimeout(grace);
  if (protocolError) return { error: protocolError };
  if (exit.timedOut) return { error: "app-server quota read timed out" };
  if (exit.code !== 0) return { error: "app-server quota process failed" };
  return response;
}

export async function fetchAccountQuotas(account: AccountConfig, workDir: string, options: QuotaReadOptions = {}): Promise<QuotaSnapshot> {
  const base = { accountId: account.id, provider: account.provider };
  const unavailable = (error: string, retryAfterSeconds?: number): QuotaSnapshot => ({ ...base,
    observedAt: new Date().toISOString(), status: "unavailable", windows: [], error,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
  if (account.enabled === false) return unavailable("account disabled");
  try {
    let response: ReadResponse;
    if (account.provider === "codex") response = await codexUsage(account, workDir, options);
    else {
      // A signed-out profile never starts the CLI. An expired access token
      // with a refresh token is fine: the CLI renews it before reading usage.
      const credential = await credentialReaderFor("claude", account.home, account.credentialStore)();
      if (credential.status !== "ok") return unavailable("credential unavailable; check official CLI login");
      const helper = account.helper?.kind === "claude-cli" ? account.helper : undefined;
      const probe = await probeClaudeCli({ account, workDir, ...(options.env ? { env: options.env } : {}) }, {
        command: options.claudeCommand ?? helper?.command, args: options.claudeArgs ?? helper?.args, timeoutMs: options.timeoutMs ?? 30_000 });
      response = probe.outcome === "completed" ? { value: probe.rateLimits } : { error: probe.detail };
    }
    if ("error" in response) return unavailable(response.error, response.retryAfterSeconds);
    const windows = account.provider === "codex" ? normalizeCodexQuotas(response.value) : normalizeClaudeQuotas(response.value);
    if (!windows.length) return unavailable("provider returned no recognized quota windows");
    return { ...base, observedAt: new Date().toISOString(), status: "ok", windows };
  } catch {
    // Process/network/credential errors may contain private data. No raw errors.
    return unavailable("quota read failed");
  }
}
