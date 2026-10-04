// Per-account credential coordination. The router schedules and serializes
// renewal; the official CLI (through a helper) performs token exchange and
// persistence; the coordinator rereads the authoritative store and accepts
// renewal only when a usable, changed credential is actually readable.

import { errorText, log, sanitize } from "./log.ts";
import type { CredentialReader, ReadResult } from "./credentials.ts";
import type { HelperContext, HelperOutcome, RenewalHelper } from "./helpers.ts";
import type { AccountConfig, UpstreamCredential } from "./types.ts";

export type AccountState = "not_enrolled" | "ready" | "renewing" | "unavailable" | "login_required";

export interface AccountStatus {
  id: string;
  provider: string;
  state: AccountState;
  expiresAt: string | undefined;
  lastRenewedAt: string | undefined;
  lastError: string | undefined;
  retryAfter: string | undefined;
  helperRuns: number;
}

export class CredentialUnavailable extends Error {
  readonly state: AccountState;
  readonly retryAfterMs: number | undefined;
  constructor(state: AccountState, message: string, retryAfterMs?: number) {
    super(message);
    this.state = state;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CoordinatorOptions {
  account: AccountConfig;
  read: CredentialReader;
  helper: RenewalHelper | undefined;
  helperContext: Omit<HelperContext, "account">;
  now?: () => number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}

const DEFAULT_RENEW_BEFORE_SECONDS = 5 * 60;

export class CredentialCoordinator {
  readonly account: AccountConfig;
  private readonly read: CredentialReader;
  private readonly helper: RenewalHelper | undefined;
  private readonly helperContext: Omit<HelperContext, "account">;
  private readonly now: () => number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;

  private state: AccountState = "not_enrolled";
  private expiresAt: number | undefined;
  private lastRenewedAt: number | undefined;
  private lastError: string | undefined;
  private failures = 0;
  private retryAt = 0;
  private helperRuns = 0;
  private externalLogin = false;
  beginLogin(): boolean { if (this.inflight || this.externalLogin) return false; this.externalLogin = true; return true; }
  endLogin(): void { this.externalLogin = false; this.retryAt = 0; this.failures = 0; }
  authenticationBusy(): boolean { return !!this.inflight || this.externalLogin; }
  private inflight: Promise<UpstreamCredential> | undefined;

  constructor(options: CoordinatorOptions) {
    this.account = options.account;
    this.read = options.read;
    this.helper = options.helper;
    this.helperContext = options.helperContext;
    this.now = options.now ?? Date.now;
    this.backoffInitialMs = options.backoffInitialMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 10 * 60_000;
  }

  status(): AccountStatus {
    const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
    return {
      id: this.account.id,
      provider: this.account.provider,
      state: this.inflight ? "renewing" : this.state,
      expiresAt: iso(this.expiresAt),
      lastRenewedAt: iso(this.lastRenewedAt),
      lastError: this.lastError,
      retryAfter: this.retryAt > this.now() ? iso(this.retryAt) : undefined,
      helperRuns: this.helperRuns,
    };
  }

  /**
   * Returns a usable credential for an upstream request, renewing through
   * the helper first when the stored credential is within its renewal
   * window. Rereads the store on every call rather than caching tokens.
   */
  async credential(): Promise<UpstreamCredential> {
    if (this.externalLogin) throw new CredentialUnavailable("login_required", "Official CLI login in progress", undefined);
    if (this.inflight) return this.inflight;
    const current = await this.readUsable();
    if (!this.isDue(current)) {
      this.markReady(current);
      return current;
    }
    return this.renew(current, false);
  }

  /**
   * Called after the upstream rejected `rejected` with 401. Rereads storage
   * and, if the credential is unchanged, forces one coordinated renewal.
   * Returns undefined when no different credential could be obtained.
   */
  async recoverFromUnauthorized(rejected: UpstreamCredential): Promise<UpstreamCredential | undefined> {
    if (this.externalLogin) return undefined;
    try {
      const current = this.inflight ? await this.inflight : await this.readUsable();
      if (current.revision !== rejected.revision) return current;
      const renewed = await this.renew(current, true);
      return renewed.revision !== rejected.revision ? renewed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Records an upstream rejection that survived recovery. */
  markRejected(detail: string): void {
    this.state = "login_required";
    this.lastError = sanitize(detail);
    log("account.rejected", { account: this.account.id, provider: this.account.provider, detail });
  }

  private isDue(credential: UpstreamCredential): boolean {
    if (credential.expiresAt === undefined) return false;
    const renewBeforeMs = (this.account.renewBeforeSeconds ?? DEFAULT_RENEW_BEFORE_SECONDS) * 1000;
    return credential.expiresAt - this.now() <= renewBeforeMs;
  }

  private isExpired(credential: UpstreamCredential): boolean {
    return credential.expiresAt !== undefined && credential.expiresAt <= this.now();
  }

  private markReady(credential: UpstreamCredential): void {
    this.state = "ready";
    this.expiresAt = credential.expiresAt;
  }

  private async readUsable(): Promise<UpstreamCredential> {
    const result: ReadResult = await this.read();
    if (result.status === "ok") return result.credential;
    if (result.status === "missing") {
      this.state = "not_enrolled";
      this.lastError = result.reason;
      throw new CredentialUnavailable("not_enrolled", "account is not enrolled");
    }
    this.state = "unavailable";
    this.lastError = result.reason;
    throw new CredentialUnavailable("unavailable", "account credential store is unusable");
  }

  private renew(current: UpstreamCredential, force: boolean): Promise<UpstreamCredential> {
    if (this.externalLogin) return Promise.reject(new CredentialUnavailable("login_required", "Official CLI login in progress", undefined));
    this.inflight ??= this.renewOnce(current, force).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async renewOnce(previous: UpstreamCredential, force: boolean): Promise<UpstreamCredential> {
    const fallback = (state: AccountState, message: string): UpstreamCredential => {
      // A due but unexpired credential remains usable while renewal fails.
      if (!force && !this.isExpired(previous)) {
        this.markReady(previous);
        return previous;
      }
      this.state = state;
      const retryAfterMs = this.retryAt > this.now() ? this.retryAt - this.now() : undefined;
      throw new CredentialUnavailable(state, message, retryAfterMs);
    };

    if (this.retryAt > this.now()) {
      return fallback(this.state === "login_required" ? "login_required" : "unavailable", "renewal is backing off");
    }

    // Another managed helper (or an earlier run) may already have renewed.
    const reread = await this.readUsable();
    if (reread.revision !== previous.revision && !this.isDue(reread)) {
      this.markReady(reread);
      return reread;
    }

    if (!this.helper) {
      this.lastError = "no renewal helper configured";
      return fallback("login_required", "credential expired and no renewal helper is configured");
    }

    this.state = "renewing";
    this.helperRuns++;
    const started = this.now();
    log("helper.start", { account: this.account.id, provider: this.account.provider, forced: force });
    const verified = await this.runAndVerify(previous);
    const durationMs = this.now() - started;
    if (verified.ok) {
      this.failures = 0;
      this.retryAt = 0;
      this.lastError = undefined;
      this.lastRenewedAt = this.now();
      this.markReady(verified.credential);
      log("helper.renewed", { account: this.account.id, provider: this.account.provider, durationMs });
      return verified.credential;
    }

    this.failures++;
    const delay = Math.min(this.backoffInitialMs * 2 ** (this.failures - 1), this.backoffMaxMs);
    this.retryAt = this.now() + delay;
    this.lastError = sanitize(verified.detail);
    const state = verified.state;
    log("helper.failed", {
      account: this.account.id,
      provider: this.account.provider,
      durationMs,
      state,
      retryInMs: delay,
      detail: verified.detail,
    });
    return fallback(state, state === "login_required" ? "interactive login required" : "credential renewal failed");
  }

  /** Runs the helper, then accepts only a changed, unexpired stored credential. */
  private async runAndVerify(
    previous: UpstreamCredential,
  ): Promise<{ ok: true; credential: UpstreamCredential } | { ok: false; state: AccountState; detail: string }> {
    let outcome: HelperOutcome;
    try {
      outcome = await this.helper!({ ...this.helperContext, account: this.account });
    } catch (error) {
      outcome = { outcome: "failed", detail: errorText(error) };
    }
    if (outcome.outcome === "login_required") return { ok: false, state: "login_required", detail: outcome.detail };
    if (outcome.outcome === "failed") return { ok: false, state: "unavailable", detail: outcome.detail };

    let after: UpstreamCredential;
    try {
      after = await this.readUsable();
    } catch (error) {
      return { ok: false, state: "unavailable", detail: `store unreadable after helper: ${errorText(error)}` };
    }
    if (after.revision === previous.revision) {
      return { ok: false, state: "unavailable", detail: "helper completed but the stored credential is unchanged" };
    }
    if (this.isExpired(after)) {
      return { ok: false, state: "unavailable", detail: "helper completed but the stored credential is expired" };
    }
    return { ok: true, credential: after };
  }
}
