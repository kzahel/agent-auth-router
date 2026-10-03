export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * The parts of a provider credential the router needs to forward a request.
 * Refresh tokens are deliberately absent: readers never return them.
 */
export interface UpstreamCredential {
  accessToken: string;
  /** Epoch milliseconds, when the store or token reveals it. */
  expiresAt: number | undefined;
  /** Provider workspace/account identifier needed on upstream requests. */
  accountId: string | undefined;
  /** Opaque comparison value for detecting replacement. Never logged. */
  revision: string;
}

export type HelperConfig =
  | {
      /** `codex app-server` JSON-RPC `account/read` with `refreshToken: true`. */
      kind: "codex-app-server";
      command?: string;
      args?: string[];
      timeoutSeconds?: number;
    }
  | {
      /** An explicit argv to run against the profile, for experiments. */
      kind: "command";
      command: string;
      args: string[];
      timeoutSeconds?: number;
    };

export interface AccountConfig {
  id: string;
  provider: Provider;
  /** Dedicated CODEX_HOME or CLAUDE_CONFIG_DIR. */
  home: string;
  /** Explicit, version-specific Keychain opt-in; absent selects file storage. */
  credentialStore?: "file" | "claude-keychain";
  enabled?: boolean;
  /** Absent means the router can read but not renew this account. */
  helper?: HelperConfig;
  renewBeforeSeconds?: number;
}

export interface GatewayClientRecord {
  id: string;
  name: string;
  tokenSha256: string;
  createdAt: string;
  revokedAt?: string;
  /** One explicitly selected account per provider in this slice. */
  accounts: Partial<Record<Provider, string>>;
}

export interface RouterConfig {
  listen: { host: string; port: number };
  /**
   * Upstream origin overrides. Only loopback http origins or https origins
   * are accepted; intended for local mock upstreams in tests.
   */
  upstreams?: Partial<Record<Provider, string>>;
  limits?: Partial<Limits>;
}

export interface Limits {
  maxBodyBytes: number;
  maxHeaderBytes: number;
  maxActiveRequests: number;
  /** Time to receive upstream response headers. */
  upstreamHeadersTimeoutMs: number;
  /** Socket inactivity bound while streaming. */
  streamIdleTimeoutMs: number;
  /** Time for a client to deliver its request headers and body. */
  clientRequestTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 32 * 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  maxActiveRequests: 64,
  upstreamHeadersTimeoutMs: 120_000,
  streamIdleTimeoutMs: 10 * 60_000,
  clientRequestTimeoutMs: 120_000,
};
