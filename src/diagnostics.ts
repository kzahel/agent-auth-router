// On-demand owner diagnostics. Messages are fixed vocabulary: never report raw
// config, provider output, paths, tokens, emails, or exception messages.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialReaderFor } from "./credentials.ts";
import type { AccountStatus, SignInState } from "./coordinator.ts";
import { directProviderProblem } from "./helpers.ts";
import { providerExecutable } from "./platform.ts";
import { helperEnv, startBounded } from "./process.ts";
import { QUOTA_FRESH_MS, type Observation } from "./pools.ts";
import type { StateStore } from "./state.ts";
import { PROVIDERS, type AccountConfig, type Provider } from "./types.ts";

export interface DiagnosticOptions { accountId?: string; checkLogin?: boolean; refreshUsage?: boolean }
export type DiagnosticAction = "accounts" | "pools" | "integrations" | "install-cli" | "start-router";
export interface DiagnosticFinding {
  code: string;
  status: "ok" | "warning" | "error" | "unknown" | "skipped";
  subject: string;
  observedAt: string;
  message: string;
  action?: DiagnosticAction;
}
export interface DiagnosticReport {
  version: 1;
  at: string;
  mode: "passive" | "check-login" | "refresh-usage";
  accountId?: string;
  findings: DiagnosticFinding[];
  exitCode: 0 | 1 | 2;
  copyText: string;
}
export interface DiagnosticRuntime {
  signIn(account: AccountConfig): Promise<SignInState>;
  refresh(account: AccountConfig): Promise<void>;
  observation(id: string): Observation;
  status(id: string): AccountStatus | undefined;
}
export interface ProviderVersion { provider: Provider; available: boolean; version?: string }

export function diagnosticOptions(body: Record<string, unknown>): DiagnosticOptions {
  if (Object.keys(body).some(k => !["accountId", "checkLogin", "refreshUsage"].includes(k))
    || (body.accountId !== undefined && (typeof body.accountId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.accountId)))
    || [body.checkLogin, body.refreshUsage].some(v => v !== undefined && typeof v !== "boolean")
    || ((body.checkLogin || body.refreshUsage) && !body.accountId)) throw new Error("Choose an account for explicit diagnostic checks; options must be valid");
  return body as DiagnosticOptions;
}

/** --version gets an isolated, empty profile location without creating it. */
export async function diagnosticProviders(): Promise<ProviderVersion[]> {
  return Promise.all(PROVIDERS.map(async provider => {
    const probe = startBounded({ command: providerExecutable(provider), args: ["--version"],
      env: helperEnv(provider, join(tmpdir(), `aar-version-${process.pid}-${provider}`)), cwd: tmpdir(),
      timeoutMs: 3000, maxStderrBytes: 0, killGraceMs: 100 });
    let output = "";
    probe.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString().slice(0, Math.max(0, 256 - output.length)); });
    probe.child.stdin?.end();
    const result = await probe.done;
    const version = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$|[-+])/.exec(output)?.[1];
    return { provider, available: result.code === 0 && !result.timedOut, ...(version ? { version } : {}) };
  }));
}

/** Reject unsafe files before parsing; do not repair permissions or follow links. */
function privateFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 8 * 1024 * 1024) throw new Error();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Unsafe or unreadable state file");
  }
}

const LOGIN_MESSAGES: Record<SignInState, string> = {
  ready: "Stored credentials are usable locally; provider access has not been checked.",
  idle: "Access token expired; official CLI renewal is configured but not verified by this check.",
  renewing: "An official login or renewal is in progress.",
  renewal_failed: "The last renewal failed for the current stored credential.",
  login_required: "Official CLI sign-in is required.",
  signed_out: "No saved login was found.",
  unusable: "The selected credential store is unsupported or unreadable.",
};

export async function diagnose(store: StateStore, options: DiagnosticOptions = {}, runtime?: DiagnosticRuntime,
  providers: () => Promise<ProviderVersion[]> = diagnosticProviders): Promise<DiagnosticReport> {
  diagnosticOptions(options as Record<string, unknown>);
  const at = new Date().toISOString(), findings: DiagnosticFinding[] = [];
  const deadline = Date.now() + 12_000;
  const bounded = async <T>(read: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) throw new Error("Diagnostic deadline");
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic deadline")), Math.max(1, deadline - Date.now()));
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  let incomplete = false;
  const add = (code: string, status: DiagnosticFinding["status"], subject: string, message: string, action?: DiagnosticAction, observedAt = at) => {
    findings.push({ code, status, subject, observedAt, message, ...(action ? { action } : {}) });
  };
  const checkProviders = async () => {
    try {
      for (const p of await bounded(providers)) add("provider-cli", p.available ? "ok" : "error", p.provider,
        p.available ? `Official CLI is available${p.version ? ` (${p.version})` : "; version unknown"}.` : "Official CLI was not found or its version check failed.", p.available ? undefined : "install-cli");
    } catch { incomplete = true; add("provider-check-failed", "unknown", "router", "CLI availability could not be checked."); }
  };
  const finish = (): DiagnosticReport => {
    const mode = options.refreshUsage ? "refresh-usage" : options.checkLogin ? "check-login" : "passive";
    const aliases = new Map<string, string>();
    const copyText = [`Agent Auth Router diagnostics v1 · ${mode} · ${at}`, ...findings.map(f => {
      // Local identifiers can reveal private account/pool inventory. Shared
      // reports retain stable references within one report, never those IDs.
      let subject = f.subject;
      if (/^(account|pool|integration|client):/.test(subject)) {
        if (!aliases.has(subject)) aliases.set(subject, `${subject.split(":")[0]} ${aliases.size + 1}`);
        subject = aliases.get(subject)!;
      }
      return `${f.status.toUpperCase()} · ${subject} · ${f.code} · ${f.message} · observed ${f.observedAt}`;
    })].join("\n");
    return { version: 1, at, mode, ...(options.accountId ? { accountId: options.accountId } : {}), findings,
      exitCode: incomplete ? 2 : findings.some(f => f.status === "error") ? 1 : 0, copyText };
  };
  try {
    const st = lstatSync(store.dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error();
    add("state-private", "ok", "router", "State directory is private and owned by this user.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      incomplete = !!options.accountId;
      add("state-missing", "warning", "router", "State directory does not exist; no files were created.", "start-router");
      await checkProviders();
    }
    else { incomplete = true; add("state-unsafe", "error", "router", "State directory is unsafe or unreadable; it was left unchanged."); }
    return finish();
  }
  const load = <T>(name: string, read: () => T): T | undefined => {
    try { privateFile(join(store.dir, name)); return read(); }
    catch { incomplete = true; add("state-invalid", "error", "router", `The ${name} state file is invalid, unsafe or unreadable; it was left unchanged.`); return undefined; }
  };
  const config = load("config.json", () => store.loadConfig());
  if (config) add("config-valid", "ok", "router", "Listener and upstream configuration pass local validation.");
  const accounts = load("accounts.json", () => store.loadAccounts());
  const clients = load("clients.json", () => {
    const values = store.loadClients();
    if (!Array.isArray(values) || values.some(v => !v || typeof v !== "object" || !v.accounts || typeof v.accounts !== "object")) throw new Error();
    return values;
  });
  const selected = accounts?.filter(a => !options.accountId || a.id === options.accountId) ?? [];
  if (options.accountId && accounts && !selected.length) { incomplete = true; add("account-missing", "error", "router", "The selected account is not enrolled.", "accounts"); }
  if (!options.accountId && (accounts?.length ?? 0) > 256) { incomplete = true; add("report-limit", "error", "router", "More than 256 accounts are enrolled; select one account for profile checks."); }
  add(runtime ? "router-running" : "router-offline", runtime ? "ok" : "warning", "router",
    runtime ? "Connected to the running router owner." : "Running router could not be reached; only local checks are available.", runtime ? undefined : "start-router");
  await checkProviders();

  const physical = new Set<string>();
  for (const account of selected.slice(0, 256)) {
    const subject = `account:${account.id}`;
    let valid = true;
    if (account.enabled === false) add("account-disabled", "warning", subject, "Account is disabled; new routing is blocked.", "accounts");
    try {
      if (!statSync(account.home).isDirectory()) throw new Error();
      const home = realpathSync(account.home);
      if (physical.has(home)) { valid = false; add("profile-shared", "error", subject, "Another enrollment refers to the same physical profile.", "accounts"); }
      physical.add(home);
      add("profile-present", "ok", subject, "Enrolled profile directory exists.");
      // Settings are configuration, not credentials. Bound them before using
      // the existing endpoint guard; never report its raw error text.
      const path = join(account.home, account.provider === "codex" ? "config.toml" : "settings.json");
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 256 * 1024) throw new Error();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (await directProviderProblem({ account, workDir: account.home })) {
        valid = false; add("profile-endpoint-override", "error", subject, "Profile configuration conflicts with direct official CLI authentication.", "accounts");
      }
      if (account.provider === "codex") {
        let configText = "";
        try { configText = readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const storage = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m.exec(configText)?.[1];
        if (storage && storage !== "file") { valid = false; add("profile-store-unsupported", "error", subject, "Codex profile does not select supported file credential storage.", "accounts"); }
      }
      if (account.credentialStore?.startsWith("claude-keychain") && process.platform !== "darwin") {
        valid = false; add("profile-store-unsupported", "error", subject, "Selected Keychain storage requires macOS.", "accounts");
      }
    } catch { valid = false; add("profile-unreadable", "error", subject, "Profile directory or configuration is missing, unsafe or unreadable.", "accounts"); }

    if (options.refreshUsage) {
      if (!runtime || !valid || account.enabled === false) add("usage-unavailable", "error", subject, "Usage refresh requires the running router and a usable enabled profile.", "accounts");
      else try { await bounded(() => runtime.refresh(account)); }
      catch { add("usage-refresh-failed", "error", subject, "Provider metadata refresh failed or is backing off; no inference was requested.", "accounts"); }
    }
    if (options.checkLogin) {
      if (!valid) add("login-skipped", "skipped", subject, "Fix the profile configuration before checking credentials.", "accounts");
      else try {
        let state: SignInState;
        if (runtime) state = await bounded(() => runtime.signIn(account));
        else {
          const read = await bounded(() => credentialReaderFor(account.provider, account.home, account.credentialStore)());
          state = read.status === "missing" ? "signed_out" : read.status !== "ok" ? "unusable"
            : read.credential.expiresAt === undefined || read.credential.expiresAt > Date.now() ? "ready"
            : read.credential.refreshable && (account.helper?.kind ?? (account.provider === "claude" ? "claude-cli" : "none")) !== "none" ? "idle" : "login_required";
        }
        add(`login-${state}`, ["login_required", "signed_out", "unusable", "renewal_failed"].includes(state) ? "error" : state === "ready" ? "ok" : "warning", subject, LOGIN_MESSAGES[state], "accounts");
      } catch { add("login-unreadable", "error", subject, "Credential status could not be read; no raw error output is included.", "accounts"); }
    } else add("login-unchecked", "unknown", subject, "Credential store was not read. Select this account and request Check sign-in to inspect it.", "accounts");

    const observation = runtime?.observation(account.id);
    if (observation?.blocked) add(observation.blocked, "error", subject,
      observation.blocked === "cooldown" ? "A provider rejection cooldown is recorded." : "Provider authentication rejection is recorded.", "accounts");
    if (observation?.quota) {
      const observedAt = observation.quota.observedAt, age = Date.now() - Date.parse(observedAt);
      const stale = !Number.isFinite(age) || age < 0 || age >= QUOTA_FRESH_MS;
      add(stale ? "quota-stale" : "quota-observed", stale ? "warning" : "ok", subject,
        stale ? "Quota observation is stale; current capacity is unknown." : "Recent quota metadata is available; it does not guarantee inference access.", "accounts", observedAt);
      if (observation.error) add("metadata-unavailable", "warning", subject, "A metadata read failed; the last successful quota observation is retained.", "accounts");
    } else add("quota-unknown", "unknown", subject, "No live quota observation is available in this router process.", "accounts");
    const status = runtime?.status(account.id);
    if (status?.lastRenewedAt) add("renewal-observed", "ok", subject, "Credential replacement was verified in this router process; this history resets at restart.", undefined, status.lastRenewedAt);
  }

  // Read the registry without constructing ControlRegistry (which migrates and
  // writes state). Only fixed messages and validated local IDs leave this read.
  const poolIds = load("control.json", () => {
    if (!privateFile(join(store.dir, "control.json"))) { add("control-uninitialized", "unknown", "router", "Pool and grant registry has not been initialized."); return; }
    const control = JSON.parse(readFileSync(join(store.dir, "control.json"), "utf8"));
    if (![1, 2, 3].includes(control.version) || !Array.isArray(control.integrations) || !Array.isArray(control.bindings)
      || (control.pools !== undefined && !Array.isArray(control.pools))) throw new Error();
    const pools: { id: string; provider: string; accountIds: string[]; deleted?: boolean }[] = control.pools ?? [];
    if (pools.length > 256 || control.integrations.length > 256) throw new Error();
    for (const pool of pools) {
      if (!/^[a-f0-9-]{36}$/.test(pool.id) || !Array.isArray(pool.accountIds) || pool.accountIds.some(id => typeof id !== "string")) throw new Error();
      if (pool.deleted) continue;
      if (options.accountId && !pool.accountIds.includes(options.accountId)) continue;
      if (!pool.accountIds.length || pool.accountIds.some(id => !accounts?.some(a => a.id === id && a.provider === pool.provider))) add("pool-members-invalid", "error", `pool:${pool.id}`, "Pool is empty or references missing or wrong-provider accounts.", "pools");
      else if (!pool.accountIds.some(id => accounts?.some(a => a.id === id && a.enabled !== false))) add("pool-disabled", "warning", `pool:${pool.id}`, "Every member of this pool is disabled.", "pools");
    }
    for (const integration of control.integrations) {
      if (!Array.isArray(integration.accountIds) || !Array.isArray(integration.poolIds)) throw new Error();
      if (integration.revoked) continue;
      if (integration.accountIds.some((id: string) => !accounts?.some(a => a.id === id)) || integration.poolIds.some((id: string) => !pools.some(p => p.id === id && !p.deleted))) add("grants-invalid", "error", "router", "An active integration grants missing accounts or pools.", "integrations");
    }
    return pools.filter(p => !p.deleted).map(p => p.id);
  });
  if (clients) for (const client of clients) {
    if (client.revokedAt) continue;
    if (accounts && Object.entries(client.accounts).some(([provider, id]) => !accounts.some(a => a.id === id && a.provider === provider))) add("client-account-invalid", "error", "router", "An active gateway client references a missing or wrong-provider account.", "integrations");
    if (client.pools && Object.values(client.pools).some(id => !poolIds?.includes(id))) add("client-pool-invalid", "error", "router", "An active gateway client references a missing pool.", "integrations");
  }
  return finish();
}
