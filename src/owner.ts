// Local owner authority. Never expose this credential or raw CLI output to a web view.
import { discoverProfiles, inspectProfile, physicalHome, profileHome, profileStore } from "./profiles.ts";
import { deleteProfile, profileRemoval } from "./profile-removal.ts";
import { TerminalLogin } from "./terminal-login.ts";
import { BUILD_INFO } from "./build-info.ts";
import { providerExecutable } from "./platform.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { COUNTERS, isMetric, isRange, isScope, type Metrics } from "./metrics.ts";
import { ControlError, type ControlRegistry } from "./control.ts";
import { CredentialCoordinator } from "./coordinator.ts";
import { credentialReaderFor } from "./credentials.ts";
import { accountHelper } from "./helpers.ts";
import type { PoolEvidence } from "./pools.ts";
import { accountEnv, helperEnv, startBounded, type BoundedProcess } from "./process.ts";
import { ensurePrivateDir, type StateStore, validateAccounts } from "./state.ts";
import { isProvider, type AccountConfig, type GatewayClientRecord } from "./types.ts";

export function ownerToken(store: StateStore, create = false): string {
  const path = join(store.dir, "owner.key");
  if (create && !existsSync(path))
    writeFileSync(path, `aar_owner_${randomBytes(32).toString("base64url")}`, {
      flag: "wx",
      mode: 0o600,
    });
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("insecure owner credential");
  const token = readFileSync(path, "utf8");
  if (!/^aar_owner_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid owner credential");
  return token;
}

/** The official CLI login command for a profile, for copy-paste sign-in. */
export function loginCommand(account: AccountConfig): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const home = quote(account.home);
  if (account.provider === "codex") {
    return `env -u OPENAI_BASE_URL -u OPENAI_API_KEY -u CODEX_API_KEY CODEX_HOME=${home} codex login`;
  }
  if (account.credentialStore === "claude-keychain-default") return `env -i PATH="$PATH" HOME=${quote(dirname(account.home))} USER=${quote(userInfo().username)} claude auth login --claudeai`;
  return `env -i PATH="$PATH" HOME="$HOME" USER=${quote(userInfo().username)} CLAUDE_CONFIG_DIR=${home} claude auth login --claudeai`;
}

/** The running web dashboard, when one is enabled. */
export interface DashboardControl {
  origin: string;
  mintCode(): { url: string; expiresAt: string };
  sessions(): object[];
  revoke(id?: string): number;
}

export function ownerRequest(
  store: StateStore,
  operation: string,
  body: object = {},
): Promise<any> {
  if (!/^[a-z/-]+$/.test(operation)) return Promise.reject(new Error("invalid owner operation"));
  const token = ownerToken(store);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: join(store.dir, "control.sock"),
        path: `/v1/owner/${operation}`,
        method: "POST",
        headers: {
          host: "localhost",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) response.destroy(new Error("owner response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200)
              reject(
                new ControlError(
                  response.statusCode ?? 503,
                  value.error ?? "owner operation failed",
                ),
              );
            else resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("owner request timed out")), 20_000);
    request.once("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

export class OwnerService {
  /** Optional services attached after construction by the runtime. */
  extensions: { metrics?: Metrics; dashboard?: DashboardControl } = {};
  private readonly token: string;
  private readonly store: StateStore;
  private readonly registry: ControlRegistry;
  private readonly coordinators: Map<string, CredentialCoordinator>;
  private readonly evidence: PoolEvidence;
  private readonly invalidate: (id: string) => void;
  private readonly origin: string;
  private readonly lifecycle: { active(): number; busy?(): number; stop(force?: boolean): void };
  private readonly terminals = new Map<string, TerminalLogin>();
  private readonly logins = new Map<
    string,
    {
      process: BoundedProcess;
      status: "running" | "complete" | "failed" | "cancelled";
      url?: string;
    }
  >();
  constructor(
    store: StateStore,
    registry: ControlRegistry,
    coordinators: Map<string, CredentialCoordinator>,
    evidence: PoolEvidence,
    invalidate: (id: string) => void,
    origin: string,
    lifecycle: { active(): number; busy?(): number; stop(force?: boolean): void },
  ) {
    this.store = store;
    this.registry = registry;
    this.coordinators = coordinators;
    this.evidence = evidence;
    this.invalidate = invalidate;
    this.origin = origin;
    this.lifecycle = lifecycle;
    this.token = ownerToken(store, true);
  }
  authenticate(header: string | undefined): void {
    const expected = Buffer.from(`Bearer ${this.token}`),
      received = Buffer.from(header ?? "");
    if (expected.length !== received.length || !timingSafeEqual(expected, received))
      throw new ControlError(401, "local owner credential required");
  }
  private account(body: Record<string, unknown>): AccountConfig {
    return (
      this.store.loadAccounts().find((a) => a.id === body.id) ??
      (() => {
        throw new ControlError(404, "account not found");
      })()
    );
  }
  private metrics(): Metrics {
    return this.extensions.metrics ?? (() => { throw new ControlError(409, "traffic metrics unavailable"); })();
  }
  private nickname(value: unknown): string {
    if (typeof value !== "string" || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new ControlError(400, "nickname must be at most 80 characters without control characters");
    return value.trim();
  }
  private coordinator(account: AccountConfig): CredentialCoordinator {
    return new CredentialCoordinator({
      account,
      read: credentialReaderFor(account.provider, account.home, account.credentialStore),
      helper: accountHelper(account),
      helperContext: { workDir: this.store.workDir, routerOrigin: this.origin },
    });
  }
  async operation(operation: string, body: Record<string, unknown>): Promise<object> {
    if (operation === "providers") {
      const providers = await Promise.all(
        (["claude", "codex"] as const).map(async (provider) => {
          const probe = startBounded({
            command: providerExecutable(provider),
            args: ["--version"],
            env: helperEnv(provider, this.store.workDir),
            cwd: this.store.workDir,
            timeoutMs: 3000,
            maxStderrBytes: 0,
          });
          let output = "";
          probe.child.stdout?.on("data", (chunk: Buffer) => {
            if (output.length < 256) output += chunk.toString().slice(0, 256 - output.length);
          });
          probe.child.stdin?.end();
          const result = await probe.done;
          return {
            provider,
            available: result.code === 0,
            version: result.code === 0 ? (output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null) : null,
          };
        }),
      );
      return { providers };
    }
    if (operation === "clients/add") {
      const record = body.record as GatewayClientRecord | undefined;
      if (
        !record ||
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.tokenSha256) ||
        !record.accounts ||
        !Object.keys(record.accounts).length
      )
        throw new ControlError(400, "invalid client");
      for (const [provider, id] of Object.entries(record.accounts))
        if (
          !this.store
            .loadAccounts()
            .some((a) => a.id === id && a.provider === provider && a.enabled !== false)
        )
          throw new ControlError(400, "invalid client account");
      const clients = this.store.loadClients();
      if (clients.some((c) => c.id === record.id)) throw new ControlError(409, "client exists");
      this.store.saveClients([...clients, record]);
      return { added: true };
    }
    if (operation === "clients/revoke") {
      const clients = this.store.loadClients(),
        client = clients.find((c) => c.id === body.id);
      if (!client) throw new ControlError(404, "client not found");
      client.revokedAt = new Date().toISOString();
      this.store.saveClients(clients);
      return { revoked: true };
    }
    if (operation === "overview")
      return {
        ...this.registry.overview(undefined, this.evidence),
        routerId: this.registry.routerId,
        build: BUILD_INFO,
        node: process.version,
        origin: this.origin,
        activeRequests: this.lifecycle.active(),
        integrations: this.registry.ownerIntegrations(),
        logins: [...this.logins, ...this.terminals].map(([id, login]) => ({ id, status: login.status })),
      };
    if (operation === "metrics/snapshot") return this.metrics().snapshot();
    if (operation === "metrics/history") {
      const range = body.range ?? "10m", scope = body.scope ?? "all", metrics = body.metrics ?? [...COUNTERS], after = body.after;
      if (!isRange(range)) throw new ControlError(400, "invalid range");
      if (!isScope(scope)) throw new ControlError(400, "invalid scope");
      if (!Array.isArray(metrics) || metrics.length > 16 || metrics.some(m => m !== "quota" && !isMetric(m))) throw new ControlError(400, "invalid metrics");
      if (after !== undefined && !Number.isSafeInteger(after)) throw new ControlError(400, "invalid after");
      return this.metrics().history(range, scope, metrics as string[], after as number | undefined);
    }
    if (operation === "requests/recent") {
      if (body.after !== undefined && !Number.isSafeInteger(body.after)) throw new ControlError(400, "invalid after");
      return { requests: this.metrics().recentRequests(body.after as number | undefined) };
    }
    if (operation === "accounts/login-command") {
      const account = this.account(body);
      return { id: account.id, command: loginCommand(account) };
    }
    if (operation.startsWith("dashboard/")) {
      const dashboard = this.extensions.dashboard ?? (() => { throw new ControlError(409, "The web dashboard is not running; start aar serve without --no-dashboard"); })();
      if (operation === "dashboard/code") return dashboard.mintCode();
      if (operation === "dashboard/sessions") return { origin: dashboard.origin, sessions: dashboard.sessions() };
      if (operation === "dashboard/revoke") {
        if (body.id !== undefined && (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id))) throw new ControlError(400, "invalid session");
        return { revoked: dashboard.revoke(body.id as string | undefined) };
      }
    }
    if (operation === "pools/save") return this.registry.savePool(body);
    if (operation === "pools/remove") return this.registry.removePool(body);
    if (operation === "grants/save") return this.registry.grant(body);
    if (operation === "integrations/revoke") {
      const integration = this.registry.ownerIntegrations().find((i) => i.id === body.id);
      if (!integration) throw new ControlError(404, "integration not found");
      return this.registry.revokeById(integration.id);
    }
    if (operation === "accounts/set-nickname") {
      const account = this.account(body);
      if (body.revision !== (account.revision ?? 0)) throw new ControlError(409, "account changed; reload before editing");
      const nickname = this.nickname(body.nickname);
      const next = { ...account, revision: (account.revision ?? 0) + 1 };
      if (nickname) next.nickname = nickname; else delete next.nickname;
      this.store.saveAccounts(this.store.loadAccounts().map(a => a.id === next.id ? next : a));
      return { updated: true };
    }
    if (operation === "profiles/discover" || operation === "profiles/inspect") {
      if (!isProvider(body.provider)) throw new ControlError(400, "invalid provider");
      if (operation === "profiles/discover") return { profiles: discoverProfiles(body.provider).map(p => ({ ...p, enrolled: this.store.loadAccounts().some(a => physicalHome(a.home) === physicalHome(p.home)) })) };
      const home = profileHome(body.home), credentialStore = profileStore(body.provider, home, body.credentialStore);
      return inspectProfile({ id: "preview", provider: body.provider, home, credentialStore });
    }
    if (operation === "accounts/add") {
      if (body.id === undefined) body.id = randomUUID();
      if (
        typeof body.id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.id) ||
        !isProvider(body.provider)
      )
        throw new ControlError(400, "invalid account id or provider");
      if (this.store.removedAccountIds().includes(body.id as string)) throw new ControlError(409, "account identity was removed; choose a new ID");
      let accounts = this.store.loadAccounts();
      if (accounts.length >= 256) throw new ControlError(409, "account limit reached");
      if (typeof body.home === "string" && body.home.startsWith("~/")) body.home = join(homedir(), body.home.slice(2));
      if (body.home !== undefined && (typeof body.home !== "string" || !isAbsolute(body.home))) throw new ControlError(400, "profile folder must be an absolute path");
      const home =
        body.home === undefined
          ? join(this.store.profilesDir, body.id)
          : typeof body.home === "string"
            ? resolve(body.home)
            : "";
      if (body.enrollment !== undefined && body.enrollment !== "existing") throw new ControlError(400, "invalid enrollment mode");
      if (body.enrollment === "existing" && body.home === undefined) throw new ControlError(400, "Choose an existing profile folder");
      const account: AccountConfig = { id: body.id, provider: body.provider, home, revision: 1 };
      const nickname = this.nickname(body.nickname ?? "");
      if (nickname) account.nickname = nickname;
      if (body.enrollment === "existing") {
        account.home = profileHome(body.home);
        account.enrollment = "existing";
        account.credentialStore = profileStore(account.provider, account.home, body.credentialStore);
        const preview = await inspectProfile(account);
        if (!preview.canEnroll) throw new ControlError(409, preview.detail);
        // Inspection awaits I/O. Reload before publishing to retain concurrent owner edits.
        accounts = this.store.loadAccounts();
        if (accounts.length >= 256) throw new ControlError(409, "account limit reached");
      } else if (body.credentialStore !== undefined) {
        if (
          body.credentialStore !== "file" &&
          !(
            body.credentialStore === "claude-keychain" &&
            body.provider === "claude" &&
            process.platform === "darwin"
          )
        )
          throw new ControlError(400, "invalid credential store");
        account.credentialStore = body.credentialStore;
      }
      if (body.helper !== undefined && body.helper !== "none" && body.helper !== "codex-app-server" && body.helper !== "claude-cli")
        throw new ControlError(400, "invalid helper");
      if (
        body.helper === "codex-app-server" ||
        (body.helper === undefined && body.provider === "codex")
      )
        account.helper = { kind: "codex-app-server" };
      else if (body.helper === "claude-cli") account.helper = { kind: "claude-cli" };
      // Claude defaults to the CLI helper; record an explicit opt-out.
      else if (body.helper === "none" && body.provider === "claude") account.helper = { kind: "none" };
      if (accounts.some(a => physicalHome(a.home) === physicalHome(account.home))) throw new ControlError(409, "profile is already enrolled");
      try {
        validateAccounts([...accounts, account]);
      } catch {
        throw new ControlError(409, "account id or profile is already enrolled, or invalid");
      }
      if (!account.enrollment) ensurePrivateDir(home);
      if (!account.enrollment && account.provider === "codex" && !existsSync(join(home, "config.toml")))
        writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', {
          flag: "wx",
          mode: 0o600,
        });
      const coordinator = this.coordinator(account);
      this.store.saveAccounts([...accounts, account]);
      this.coordinators.set(account.id, coordinator);
      this.invalidate(account.id);
      return { id: account.id, provider: account.provider, revision: 1 };
    }
    if (operation === "accounts/removal-preview") {
      const account = this.account(body);
      return { id: account.id, revision: account.revision ?? 0, home: account.home, ...profileRemoval(this.store, account) };
    }
    if (operation === "accounts/remove") {
      const account = this.account(body);
      if (body.revision !== (account.revision ?? 0)) throw new ControlError(409, "Account changed; reopen the Remove dialog.");
      if (body.deleteProfile !== undefined && typeof body.deleteProfile !== "boolean") throw new ControlError(400, "deleteProfile must be a boolean");
      // No await between this gate and removal. Do not race router-owned writes
      // or let a new enrollment overlap an old sign-in/renewal using its folder.
      if (this.lifecycle.active() || this.lifecycle.busy?.() || this.coordinators.get(account.id)?.authenticationBusy()
        || this.logins.get(account.id)?.status === "running" || this.terminals.get(account.id)?.busy())
        throw new ControlError(409, "Router busy; finish requests, usage checks and this account's sign-ins before removing it.");
      if (body.deleteProfile) {
        const preview = profileRemoval(this.store, account);
        if (!preview.canDeleteProfile) throw new ControlError(409, preview.reason);
        if (body.home !== account.home || body.deleteIdentity !== preview.deleteIdentity) throw new ControlError(409, "Profile folder changed; reopen the Remove dialog.");
        // A partial filesystem failure must leave an inspectable, disabled row.
        this.store.saveAccounts(this.store.loadAccounts().map(a => a.id === account.id ? { ...a, enabled: false, revision: (a.revision ?? 0) + 1 } : a));
        const coordinator = this.coordinators.get(account.id);
        if (coordinator) coordinator.account.enabled = false;
        this.invalidate(account.id);
        try { deleteProfile(this.store, account, preview.deleteIdentity!); }
        catch { throw new ControlError(409, "Could not fully delete the profile folder. The account is disabled and remains in the list. Reload to inspect it or remove it without deleting files."); }
      }
      this.store.removeAccount(account.id);
      this.coordinators.delete(account.id);
      this.logins.delete(account.id);
      this.terminals.delete(account.id);
      this.invalidate(account.id);
      this.registry.forgetAccounts([account.id]);
      return { removed: true, profileDeleted: body.deleteProfile === true };
    }
    if (operation === "accounts/set-enabled" || operation === "accounts/retire") {
      const account = this.account(body);
      if (body.revision !== (account.revision ?? 0))
        throw new ControlError(409, "account changed; reload before editing");
      if (account.retired)
        throw new ControlError(409, "account retired; enroll a new identity instead");
      if (operation === "accounts/retire") body.enabled = false;
      if (typeof body.enabled !== "boolean") throw new ControlError(400, "enabled must be boolean");
      const next = {
        ...account,
        ...(operation === "accounts/retire" ? { retired: true } : {}),
        enabled: body.enabled,
        revision: (account.revision ?? 0) + 1,
      };
      this.store.saveAccounts(this.store.loadAccounts().map((a) => (a.id === next.id ? next : a)));
      const coordinator = this.coordinators.get(next.id);
      if (coordinator) coordinator.account.enabled = next.enabled;
      // Preserve the existing coordinator and accepted streams; admission reads enabled state.
      if (!next.enabled) { this.logins.get(next.id)?.process.terminate(); this.terminals.get(next.id)?.cancel(); }
      this.invalidate(next.id);
      return { updated: true };
    }
    if (operation === "accounts/refresh") {
      const account = this.account(body);
      if (account.enabled === false) throw new ControlError(409, "account disabled");
      await this.evidence.refresh(account.id);
      return this.operation("overview", {});
    }
    if (operation === "accounts/renew") {
      const account = this.account(body),
        coordinator = this.coordinators.get(account.id);
      if (account.enabled === false || !coordinator)
        throw new ControlError(409, "account unavailable");
      const before = await credentialReaderFor(
        account.provider,
        account.home,
        account.credentialStore,
      )();
      if (before.status !== "ok") throw new ControlError(409, "Sign in before attempting renewal");
      const renewed = await coordinator.recoverFromUnauthorized(before.credential);
      this.invalidate(account.id);
      return {
        id: account.id,
        replaced: !!renewed,
        state: coordinator.status().state,
        expiresAt: renewed?.expiresAt ?? null,
      };
    }
    if (operation === "accounts/login-status") {
      const account = this.account(body),
        signIn = await (this.coordinators.get(account.id) ?? this.coordinator(account)).signIn();
      return {
        id: account.id,
        signIn: signIn.state,
        detail: signIn.detail ?? null,
        expiresAt: signIn.expiresAt !== undefined ? new Date(signIn.expiresAt).toISOString() : null,
        loginStatus: this.terminals.get(account.id)?.status ?? this.logins.get(account.id)?.status ?? "idle",
        canOpenLogin: this.logins.get(account.id)?.status === "running" && !!this.logins.get(account.id)?.url,
      };
    }
    if (operation.startsWith("accounts/terminal-")) {
      const account = this.account(body);
      if (operation === "accounts/terminal-begin") {
        if (account.enabled === false || this.terminals.get(account.id)?.busy() || this.logins.get(account.id)?.status === "running") throw new ControlError(409, "account unavailable or sign-in already running");
        if (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 1 || body.pid === process.pid) throw new ControlError(400, "invalid terminal process");
        const coordinator = this.coordinators.get(account.id);
        if (!coordinator?.beginLogin()) throw new ControlError(409, "account authentication already running");
        this.logins.delete(account.id);
        const terminal = new TerminalLogin(body.pid as number, () => { coordinator.endLogin(); this.invalidate(account.id); });
        this.terminals.set(account.id, terminal);
        this.invalidate(account.id);
        return { token: terminal.token };
      }
      const terminal = this.terminals.get(account.id);
      if (!terminal || body.token !== terminal.token) throw new ControlError(409, "terminal sign-in changed");
      if (operation === "accounts/terminal-attach") {
        if (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 1 || body.pid === process.pid) throw new ControlError(400, "invalid CLI process");
        terminal.attach(body.pid as number);
      } else if (operation === "accounts/terminal-end") terminal.end(body.success === true);
      else if (operation !== "accounts/terminal-status") throw new ControlError(404, "unknown terminal operation");
      return { status: terminal.status };
    }
    if (operation === "accounts/login") {
      const account = this.account(body);
      if (account.enabled === false) throw new ControlError(409, "account disabled");
      if (
        this.logins.get(account.id)?.status === "running" ||
        this.terminals.get(account.id)?.busy() ||
        this.coordinators.get(account.id)?.status().state === "renewing"
      )
        throw new ControlError(409, "account authentication already running");
      const coordinator = this.coordinators.get(account.id);
      if (!coordinator?.beginLogin())
        throw new ControlError(409, "account authentication already running");
      this.terminals.delete(account.id);
      this.invalidate(account.id);
      const child = startBounded({
        command: providerExecutable(account.provider),
        args: account.provider === "codex" ? ["login"] : ["auth", "login", "--claudeai"],
        env: accountEnv(account),
        cwd: this.store.workDir,
        timeoutMs: 10 * 60_000,
        maxStderrBytes: 0,
      });
      child.child.stdin?.end();
      const login: {
        process: BoundedProcess;
        status: "running" | "complete" | "failed" | "cancelled";
        url?: string;
      } = { process: child, status: "running" };
      this.logins.set(account.id, login);
      // Retain only an allowlisted official authorization URL, never raw output.
      let tail = "";
      const observe = (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-8192);
        for (const match of tail.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
          try {
            const url = new URL(match[0]);
            if (
              [
                "auth.openai.com",
                "claude.ai",
                "platform.claude.com",
                "console.anthropic.com",
              ].includes(url.hostname) &&
              url.pathname === "/oauth/authorize" &&
              !url.username &&
              !url.password &&
              !url.port &&
              !url.hash &&
              ![...url.searchParams.keys()].some((key) =>
                /(?:access_token|refresh_token|secret|password)/i.test(key),
              )
            )
              login.url = url.href;
          } catch {}
        }
      };
      child.child.stdout?.on("data", observe);
      child.child.stderr?.on("data", observe);
      void child.done.then((result) => {
        coordinator.endLogin();
        if (login.status !== "cancelled") login.status = result.code === 0 ? "complete" : "failed";
        this.invalidate(account.id);
      });
      return { id: account.id, status: login.status };
    }
    if (operation === "accounts/open-login") {
      const account = this.account(body),
        url = this.logins.get(account.id)?.url;
      if (!url || account.enabled === false || this.logins.get(account.id)?.status !== "running")
        throw new ControlError(409, "No official sign-in page is available yet");
      if (process.platform !== "darwin")
        throw new ControlError(409, "Opening sign-in pages is currently supported on macOS");
      const opened = startBounded({
        command: "/usr/bin/open",
        args: [url],
        cwd: this.store.workDir,
        env: accountEnv(account),
        timeoutMs: 3000,
        maxStderrBytes: 0,
      });
      opened.child.stdout?.resume();
      opened.child.stdin?.end();
      if ((await opened.done).code !== 0)
        throw new ControlError(503, "Could not open the official sign-in page");
      return { opened: true };
    }
    if (operation === "accounts/cancel-login") {
      this.terminals.get(this.account(body).id)?.cancel();
      const account = this.account(body),
        login = this.logins.get(account.id);
      if (login) {
        login.status = "cancelled";
        login.process.terminate();
      }
      return { cancelled: true };
    }
    if (operation === "stop" || operation === "shutdown") {
      if (body.routerId !== this.registry.routerId)
        throw new ControlError(409, "router identity changed");
      if (operation === "stop" && (
        this.lifecycle.active() ||
        this.lifecycle.busy?.() ||
        [...this.coordinators.values()].some((c) => c.status().state === "renewing") ||
        [...this.logins.values()].some((l) => l.status === "running") ||
        [...this.terminals.values()].some(t => t.busy())
      ))
        throw new ControlError(409, "router busy; finish requests and logins before stopping");
      this.lifecycle.stop(operation === "shutdown");
      return { stopping: true };
    }
    throw new ControlError(404, "unknown owner operation");
  }
  async close(): Promise<void> {
    for (const login of this.logins.values()) login.process.terminate();
    await Promise.all([...this.logins.values()].map((l) => l.process.done));
    await Promise.all([...this.terminals.values()].map(t => t.close()));
  }
}
