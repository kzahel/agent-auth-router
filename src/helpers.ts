import { providerExecutable } from "./platform.ts";
// Renewal helpers. A helper asks the official CLI to renew and persist the
// profile's credential; it never returns token material. The coordinator
// rereads the store afterward to decide whether renewal happened.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeCliModels, type CliModel } from "./contract.ts";
import { accountEnv, helperEnv, startBounded, type ProcessResult } from "./process.ts";
import type { AccountConfig, HelperConfig } from "./types.ts";

export type HelperOutcome =
  | { outcome: "completed" }
  | { outcome: "login_required"; detail: string }
  | { outcome: "failed"; detail: string };

export interface HelperContext {
  account: AccountConfig;
  /** Neutral working directory for the helper process. */
  workDir: string;
  /** The router's own listener origin, which a helper must never target. */
  routerOrigin?: string;
  env?: NodeJS.ProcessEnv;
}

export type RenewalHelper = (context: HelperContext) => Promise<HelperOutcome>;

export function helperFor(config: HelperConfig): RenewalHelper | undefined {
  if (config.kind === "none") return undefined;
  if (config.kind === "codex-app-server") return (context) => runCodexAppServer(config, context);
  if (config.kind === "claude-cli") return (context) => runClaudeCli(config, context);
  return (context) => runCommand(config, context);
}

/** Explicit helper configuration, else the provider default. */
export function accountHelper(account: AccountConfig): RenewalHelper | undefined {
  return helperFor(account.helper ?? (account.provider === "claude" ? { kind: "claude-cli" } : { kind: "none" }));
}

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * Refuses to run a helper whose dedicated profile configuration could route
 * it away from the real provider (for example back through this router).
 * This is a conservative textual check of the files the official CLIs read
 * from their home directory; it does not model every configuration layer.
 */
export async function directProviderProblem(context: HelperContext): Promise<string | undefined> {
  const { account } = context;
  const file = account.provider === "codex" ? "config.toml" : "settings.json";
  let text: string;
  try {
    text = await readFile(join(account.home, file), "utf8");
  } catch {
    return undefined;
  }
  if (context.routerOrigin && text.includes(new URL(context.routerOrigin).host)) {
    return `profile ${file} references the router listener`;
  }
  if (account.provider === "codex") {
    if (/^\s*(?:openai_base_url|chatgpt_base_url|model_provider)\s*=/m.test(text) || /^\s*base_url\s*=/m.test(text)) {
      return "profile config.toml overrides the provider endpoint";
    }
    return undefined;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return "profile settings.json is not valid JSON";
  }
  const object = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  if ("apiKeyHelper" in object) return "profile settings.json defines apiKeyHelper";
  const env = object.env && typeof object.env === "object" ? Object.keys(object.env) : [];
  const overridden = env.filter((key) =>
    /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/.test(key),
  );
  return overridden.length ? `profile settings.json overrides ${overridden.join(", ")}` : undefined;
}

function describeExit(result: ProcessResult): string {
  if (result.timedOut) return "helper timed out";
  if (result.signal) return `helper exited by ${result.signal}`;
  return `helper exited with status ${result.code}`;
}

async function runCommand(config: Extract<HelperConfig, { kind: "command" }>, context: HelperContext): Promise<HelperOutcome> {
  const problem = await directProviderProblem(context);
  if (problem) return { outcome: "failed", detail: problem };
  const proc = startBounded({
    command: config.command,
    args: config.args,
    env: accountEnv(context.account, context.env),
    cwd: context.workDir,
    timeoutMs: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  });
  proc.child.stdin?.end();
  proc.child.stdout?.resume();
  const result = await proc.done;
  if (result.code === 0 && !result.timedOut) return { outcome: "completed" };
  return { outcome: "failed", detail: `${describeExit(result)}: ${result.stderrTail.slice(-200)}` };
}

const MAX_LINE_BYTES = 1024 * 1024;
const EXIT_GRACE_MS = 5_000;

/**
 * Speaks the Codex app-server stdio protocol (JSONL, JSON-RPC without the
 * "jsonrpc" member): initialize, initialized, then `account/read` with
 * `refreshToken: true`, which the 0.155 schema documents as triggering the
 * normal refresh-token flow in managed auth mode. Whether the refreshed
 * credential is durably persisted is verified by the coordinator, not here.
 * Read cached account state first: a null account after a failed forced
 * refresh does not establish that an enrolled profile needs a new login.
 */
async function runCodexAppServer(
  config: Extract<HelperConfig, { kind: "codex-app-server" }>,
  context: HelperContext,
): Promise<HelperOutcome> {
  const problem = await directProviderProblem(context);
  if (problem) return { outcome: "failed", detail: problem };

  const proc = startBounded({
    command: config.command ?? providerExecutable("codex"),
    args: config.args ?? ["app-server"],
    env: helperEnv("codex", context.account.home, context.env),
    cwd: context.workDir,
    timeoutMs: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  });
  const { child } = proc;
  const send = (message: Record<string, unknown>) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify(message) + "\n");
  };
  child.stdin?.on("error", () => {});

  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  let protocolError: string | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      protocolError = "app-server line exceeded size bound";
      proc.terminate();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        // Server-initiated request (approvals, external token refresh). This
        // helper offers no capabilities, so decline rather than hang.
        send({ id: message.id, error: { code: -32601, message: "not supported by agent-auth-router helper" } });
      } else if (typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });

  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown> | undefined>((resolve) => {
      pending.set(id, resolve);
      proc.done.then(() => resolve(undefined));
      send({ id, method, params });
    });

  const finish = async (outcome: HelperOutcome): Promise<HelperOutcome> => {
    child.stdin?.end();
    const grace = setTimeout(() => proc.terminate(), EXIT_GRACE_MS);
    grace.unref();
    const result = await proc.done;
    clearTimeout(grace);
    if (outcome.outcome === "completed" && result.timedOut) {
      return { outcome: "failed", detail: "app-server did not exit before the helper deadline" };
    }
    return outcome;
  };

  const init = await request(1, "initialize", { clientInfo: { name: "agent-auth-router", version: "0.0.0" } });
  if (!init || "error" in init) {
    const detail = init ? rpcError(init) : `${describeExit(await proc.done)} before initialize`;
    return finish({ outcome: "failed", detail: protocolError ?? detail });
  }
  send({ method: "initialized" });

  const initial = await request(2, "account/read", { refreshToken: false });
  if (!initial) {
    const detail = `${describeExit(await proc.done)} before initial account/read completed`;
    return finish({ outcome: "failed", detail: protocolError ?? detail });
  }
  if ("error" in initial) return finish({ outcome: "failed", detail: rpcError(initial) });
  const initialResult = initial.result as { account?: { type?: unknown } | null } | undefined;
  if (!initialResult?.account) {
    return finish({ outcome: "login_required", detail: "app-server reports no signed-in account before refresh" });
  }
  if (initialResult.account.type !== "chatgpt") {
    return finish({ outcome: "failed", detail: `profile account type is ${String(initialResult.account.type)}, not chatgpt` });
  }

  const read = await request(3, "account/read", { refreshToken: true });
  if (!read) {
    const detail = `${describeExit(await proc.done)} before account/read completed`;
    return finish({ outcome: "failed", detail: protocolError ?? detail });
  }
  if ("error" in read) return finish({ outcome: "failed", detail: rpcError(read) });
  const result = read.result as { account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown } | undefined;
  if (!result?.account) {
    return finish({ outcome: "failed", detail: "app-server returned no account after refresh; renewal was not verified" });
  }
  if (result.account.type !== "chatgpt") {
    return finish({ outcome: "failed", detail: `profile account type is ${String(result.account.type)}, not chatgpt` });
  }
  return finish({ outcome: "completed" });
}

function rpcError(message: Record<string, unknown>): string {
  const error = message.error as { message?: unknown; code?: unknown } | undefined;
  return `app-server error ${String(error?.code ?? "")}: ${String(error?.message ?? "unknown")}`.slice(0, 200);
}

/**
 * Claude Code's SDK control protocol over stdio, without the SDK: the CLI
 * started with stream-json input/output accepts `control_request` lines and
 * answers with `control_response` lines (Claude Code 2.1.280 observation).
 * No prompt is sent, so no model session or inference runs. Settings, MCP
 * servers, tools and session persistence are disabled for isolation.
 */
export const CLAUDE_CLI_ARGS: readonly string[] = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--strict-mcp-config", "--setting-sources=", "--tools", "",
];

/**
 * `cliModels` is the CLI's own `initialize.models` list, present once the
 * profile is known to be a signed-in subscription login, whether or not the
 * usage read that follows succeeds.
 */
export type ClaudeProbe = (
  | { outcome: "completed"; rateLimits: Record<string, unknown> }
  | Exclude<HelperOutcome, { outcome: "completed" }>
) & { cliModels?: CliModel[] };

export interface ClaudeProbeOptions {
  command?: string | undefined;
  args?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

const claudeProbes = new Map<string, Promise<ClaudeProbe>>();

/**
 * `initialize`, then `get_usage`. The CLI refreshes an expired access token
 * itself before reading usage, so this is both the Claude usage reader and
 * its renewal helper. One probe per profile at a time: concurrent usage reads
 * and renewal share it, so two CLIs never refresh the same login at once.
 */
export function probeClaudeCli(context: HelperContext, options: ClaudeProbeOptions = {}): Promise<ClaudeProbe> {
  const key = context.account.home;
  let probe = claudeProbes.get(key);
  if (!probe) {
    probe = runClaudeProbe(context, options).finally(() => claudeProbes.delete(key));
    claudeProbes.set(key, probe);
  }
  return probe;
}

async function runClaudeCli(config: Extract<HelperConfig, { kind: "claude-cli" }>, context: HelperContext): Promise<HelperOutcome> {
  const probe = await probeClaudeCli(context, {
    command: config.command,
    args: config.args,
    timeoutMs: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  });
  if (probe.outcome === "completed") return { outcome: "completed" };
  const { cliModels: _cliModels, ...outcome } = probe;
  return outcome;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

async function runClaudeProbe(context: HelperContext, options: ClaudeProbeOptions): Promise<ClaudeProbe> {
  const problem = await directProviderProblem(context);
  if (problem) return { outcome: "failed", detail: problem };

  const proc = startBounded({
    command: options.command ?? providerExecutable("claude"),
    args: options.args ?? CLAUDE_CLI_ARGS,
    env: accountEnv(context.account, context.env),
    cwd: context.workDir,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000,
    maxStderrBytes: 0,
  });
  const { child } = proc;
  const send = (message: Record<string, unknown>) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify(message) + "\n");
  };
  child.stdin?.on("error", () => {});

  const pending = new Map<string, (response: Record<string, unknown>) => void>();
  let buffer = "";
  let protocolError: string | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (protocolError) return;
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      protocolError = "Claude CLI line exceeded size bound";
      proc.terminate();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown> | undefined;
      try {
        message = object(JSON.parse(line));
      } catch {
        continue;
      }
      if (message?.type === "control_request" && typeof message.request_id === "string") {
        // Permission and hook callbacks are unexpected without a prompt.
        // Decline rather than hang.
        send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "not supported by agent-auth-router probe" } });
      } else if (message?.type === "control_response") {
        const response = object(message.response);
        if (typeof response?.request_id === "string") {
          pending.get(response.request_id)?.(response);
          pending.delete(response.request_id);
        }
      }
    }
  });

  const request = (id: string, subtype: string) =>
    new Promise<Record<string, unknown> | undefined>((resolve) => {
      pending.set(id, resolve);
      proc.done.then(() => resolve(undefined));
      send({ type: "control_request", request_id: id, request: { subtype } });
    });

  const finish = async (outcome: ClaudeProbe): Promise<ClaudeProbe> => {
    child.stdin?.end();
    const grace = setTimeout(() => proc.terminate(), EXIT_GRACE_MS);
    grace.unref();
    await proc.done;
    clearTimeout(grace);
    return outcome;
  };
  // Provider error text is never retained; only fixed descriptions leave here.
  const failed = async (response: Record<string, unknown> | undefined, step: string): Promise<ClaudeProbe> =>
    finish({ outcome: "failed", detail: protocolError ?? (response ? `Claude CLI rejected ${step}` : `${describeExit(await proc.done)} before ${step} completed`) });

  const init = await request("aar-initialize", "initialize");
  if (init?.subtype !== "success") return failed(init, "initialize");
  const account = object(object(init.response)?.account);
  if (!account || account.tokenSource === "none") {
    return finish({ outcome: "login_required", detail: "Claude CLI reports no saved login for this profile" });
  }
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return finish({ outcome: "failed", detail: "profile does not use a Claude subscription login" });
  }

  const cliModels = sanitizeCliModels(object(init.response)?.models);
  const withModels = (outcome: ClaudeProbe): ClaudeProbe => cliModels ? { ...outcome, cliModels } : outcome;

  const usage = await request("aar-usage", "get_usage");
  if (usage?.subtype !== "success") return withModels(await failed(usage, "get_usage"));
  const value = object(usage.response), rateLimits = object(value?.rate_limits);
  if (value?.rate_limits_available !== true || !rateLimits) {
    return finish(withModels({ outcome: "failed", detail: "Claude CLI returned no subscription usage; the saved login may need renewal" }));
  }
  return finish(withModels({ outcome: "completed", rateLimits }));
}
