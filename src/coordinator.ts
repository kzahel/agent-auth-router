// Per-account credential coordination. The router schedules and serializes
// renewal; the official CLI (through a helper) performs token exchange and
// persistence; the coordinator rereads the authoritative store and accepts
// renewal only when a usable, changed credential is actually readable.

import { errorText, log, sanitize } from "./log.ts";
import { loginEndedReason, type CredentialReader, type ReadResult } from "./credentials.ts";
import type { HelperContext, HelperOutcome, RenewalHelper } from "./helpers.ts";
import type { AccountConfig, UpstreamCredential } from "./types.ts";

export type AccountState = "not_enrolled" | "ready" | "renewing" | "unavailable" | "login_required";

/**
 * Owner-facing sign-in state. An expired access token is not a lost login:
 * with a refresh token and a helper, the official CLI renews it on next use.
 * Only a failed renewal or rejection of the current credential, or a missing
 * refresh token, requires signing in again.
 */
export type SignInState = "ready" | "idle" | "renewing" | "renewal_failed" | "login_required" | "signed_out" | "unusable";

export interface AccountStatus {
  id: string;
  provider: string;
  state: AccountState;
  expiresAt: string | undefined;
  /** When the stored login needs an interactive sign-in, as last read. */
  loginExpiresAt: string | undefined;
  lastRenewedAt: string | undefined;
  lastError: string | undefined;
  retryAfter: string | undefined;
  helperRuns: number;
}

export const LOGIN_IN_PROGRESS = "Official CLI login in progress";

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
  private loginExpiresAt: number | undefined;
  private lastRenewedAt: number | undefined;
  private lastError: string | undefined;
  /** Revision of the credential a failed renewal or rejection applied to. */
  private failedRevision: string | undefined;
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
      loginExpiresAt: iso(this.loginExpiresAt),
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
    if (this.externalLogin) throw new CredentialUnavailable("login_required", LOGIN_IN_PROGRESS, undefined);
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

  /**
   * Classifies the current stored credential for the owner. Rereads storage;
   * never runs a helper. A recorded failure applies only while the same
   * credential is stored, so a new sign-in clears it immediately.
   */
  async signIn(): Promise<{ state: SignInState; expiresAt: number | undefined; loginExpiresAt: number | undefined; detail: string | undefined }> {
    const result = this.observe(await this.read());
    const loginExpiresAt = this.loginExpiresAt;
    if (this.inflight) return { state: "renewing", expiresAt: this.expiresAt, loginExpiresAt, detail: undefined };
    if (result.status === "missing") return { state: "signed_out", expiresAt: undefined, loginExpiresAt, detail: result.reason };
    if (result.status === "signed_out") return { state: "login_required", expiresAt: undefined, loginExpiresAt, detail: loginEndedReason(result.loginExpiresAt, this.now()) };
    if (result.status !== "ok") return { state: "unusable", expiresAt: undefined, loginExpiresAt, detail: result.reason };
    const { credential } = result;
    if (this.externalLogin) return { state: "renewing", expiresAt: credential.expiresAt, loginExpiresAt, detail: "official CLI login in progress" };
    if (credential.revision === this.failedRevision && (this.state === "login_required" || this.state === "unavailable")) {
      return { state: this.state === "login_required" ? "login_required" : "renewal_failed", expiresAt: credential.expiresAt, loginExpiresAt, detail: this.lastError };
    }
    if (!this.isExpired(credential)) return { state: "ready", expiresAt: credential.expiresAt, loginExpiresAt, detail: undefined };
    if (this.loginLapsed(credential)) return { state: "login_required", expiresAt: credential.expiresAt, loginExpiresAt, detail: loginEndedReason(loginExpiresAt, this.now()) };
    if (credential.refreshable && this.helper) return { state: "idle", expiresAt: credential.expiresAt, loginExpiresAt, detail: "access token expired; the official CLI renews it on next use" };
    return { state: "login_required", expiresAt: credential.expiresAt, loginExpiresAt, detail: credential.refreshable ? "access token expired and no renewal helper is configured" : "access token expired and no refresh token is stored" };
  }

  /** Remembers the login deadline of every read, so status needs no store access. */
  private observe(result: ReadResult): ReadResult {
    if (result.status === "ok") this.loginExpiresAt = result.credential.loginExpiresAt;
    else if (result.status === "signed_out") this.loginExpiresAt = result.loginExpiresAt;
    return result;
  }

  private loginLapsed(credential: UpstreamCredential): boolean {
    return credential.loginExpiresAt !== undefined && credential.loginExpiresAt <= this.now();
  }

  /** Records an upstream rejection that survived recovery. */
  markRejected(detail: string, rejected?: UpstreamCredential): void {
    this.failedRevision = rejected?.revision;
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
    const result = this.observe(await this.read());
    if (result.status === "ok") return result.credential;
    if (result.status === "missing") {
      this.state = "not_enrolled";
      this.lastError = result.reason;
      throw new CredentialUnavailable("not_enrolled", "account is not enrolled");
    }
    if (result.status === "signed_out") {
      this.state = "login_required";
      this.lastError = loginEndedReason(result.loginExpiresAt, this.now());
      throw new CredentialUnavailable("login_required", this.lastError);
    }
    this.state = "unavailable";
    this.lastError = result.reason;
    throw new CredentialUnavailable("unavailable", `account credential store is unusable: ${result.reason}`);
  }

  private renew(current: UpstreamCredential, force: boolean): Promise<UpstreamCredential> {
    if (this.externalLogin) return Promise.reject(new CredentialUnavailable("login_required", LOGIN_IN_PROGRESS, undefined));
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
      this.failedRevision = previous.revision;
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
    let verified = await this.runAndVerify(previous);
    // Past the login's lifetime a failed renewal is a lapsed login, whatever the CLI reported.
    if (!verified.ok && this.loginLapsed(previous)) {
      const loginEnded = loginEndedReason(previous.loginExpiresAt, this.now());
      verified = { ok: false, state: "login_required", detail: loginEnded, loginEnded };
    }
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
    // A CLI may decline to refresh until closer to expiry. Never let that
    // backoff outlast the credential, or the first expired request would
    // fail without giving the CLI its chance to renew.
    const unchangedEarly = !force && verified.unchanged && !this.isExpired(previous) && previous.expiresAt !== undefined;
    this.retryAt = unchangedEarly ? Math.min(this.now() + delay, previous.expiresAt!) : this.now() + delay;
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
    return fallback(state, state !== "login_required" ? "credential renewal failed" : verified.loginEnded ?? "interactive login required");
  }

  /** Runs the helper, then accepts only a changed, unexpired stored credential. */
  private async runAndVerify(
    previous: UpstreamCredential,
  ): Promise<{ ok: true; credential: UpstreamCredential } | { ok: false; state: AccountState; detail: string; unchanged?: boolean; loginEnded?: string }> {
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
      if (error instanceof CredentialUnavailable && error.state === "login_required") return { ok: false, state: "login_required", detail: error.message, loginEnded: error.message };
      return { ok: false, state: "unavailable", detail: `store unreadable after helper: ${errorText(error)}` };
    }
    if (after.revision === previous.revision) {
      return { ok: false, state: "unavailable", detail: "helper completed but the stored credential is unchanged", unchanged: true };
    }
    if (this.isExpired(after)) {
      return { ok: false, state: "unavailable", detail: "helper completed but the stored credential is expired" };
    }
    return { ok: true, credential: after };
  }
}
