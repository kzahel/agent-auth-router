// Provider adapters: allowlisted routes, the fixed upstream origin, and
// request header policy. Paths, headers and the Claude OAuth beta flag are
// source observations for the CLI versions in docs/prototype.md; real-client
// compatibility is not yet verified.

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { Provider, UpstreamCredential } from "./types.ts";

export interface Route {
  method: "GET" | "POST";
  /** Path below the provider prefix, matched exactly (query excluded). */
  path: string;
  upstreamPath: string;
}

export interface ProviderAdapter {
  provider: Provider;
  defaultOrigin: string;
  routes: readonly Route[];
  forwardHeader(name: string): boolean;
  upstreamHeaders(credential: UpstreamCredential, incoming: IncomingHttpHeaders): OutgoingHttpHeaders;
}

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

const claude: ProviderAdapter = {
  provider: "claude",
  defaultOrigin: "https://api.anthropic.com",
  routes: [
    { method: "POST", path: "/v1/messages", upstreamPath: "/v1/messages" },
    { method: "POST", path: "/v1/messages/count_tokens", upstreamPath: "/v1/messages/count_tokens" },
    { method: "GET", path: "/v1/models", upstreamPath: "/v1/models" },
  ],
  forwardHeader: (name) =>
    ["content-type", "accept", "user-agent", "x-app"].includes(name) ||
    name.startsWith("anthropic-") ||
    name.startsWith("x-stainless-") ||
    name.startsWith("x-claude-code-"),
  upstreamHeaders(credential, incoming) {
    const betas = String(incoming["anthropic-beta"] ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean);
    if (!betas.includes(CLAUDE_OAUTH_BETA)) betas.push(CLAUDE_OAUTH_BETA);
    return {
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-beta": betas.join(","),
      "anthropic-version": incoming["anthropic-version"] ?? "2023-06-01",
    };
  },
};

const codex: ProviderAdapter = {
  provider: "codex",
  defaultOrigin: "https://chatgpt.com",
  routes: [
    { method: "POST", path: "/responses", upstreamPath: "/backend-api/codex/responses" },
    { method: "POST", path: "/responses/compact", upstreamPath: "/backend-api/codex/responses/compact" },
    { method: "GET", path: "/models", upstreamPath: "/backend-api/codex/models" },
  ],
  forwardHeader: (name) =>
    ["content-type", "accept", "user-agent", "originator", "version", "session_id", "conversation_id", "openai-beta"].includes(
      name,
    ) || name.startsWith("x-codex-"),
  upstreamHeaders(credential) {
    const headers: OutgoingHttpHeaders = { authorization: `Bearer ${credential.accessToken}` };
    if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;
    return headers;
  },
};

export const ADAPTERS: Record<Provider, ProviderAdapter> = { claude, codex };

/** Response headers never relayed to clients. */
const RESPONSE_HEADER_DENYLIST = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "location",
  "alt-svc",
  "trailer",
  "te",
]);

export function relayableResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || RESPONSE_HEADER_DENYLIST.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Validates an upstream origin override. Only https, or plain http to a
 * loopback address (local mock upstreams), and only a bare origin.
 */
export function parseUpstreamOrigin(value: string): URL {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("upstream override must be a bare origin");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("upstream override must use https unless it is loopback");
  }
  return url;
}
