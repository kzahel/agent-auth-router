import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { GatewayClientRecord, Provider } from "./types.ts";

const TOKEN_PREFIX = "aar_";

export function generateGatewayToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashGatewayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Extracts the presented gateway token. Claude Code sends either
 * `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN) or `x-api-key`
 * (ANTHROPIC_API_KEY); Codex sends `Authorization: Bearer` from its
 * provider `env_key`.
 */
export function presentedToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return undefined;
}

export type AuthDecision =
  | { ok: true; client: GatewayClientRecord; accountId: string }
  | { ok: false; status: 401 | 403; message: string };

export function authorize(
  clients: readonly GatewayClientRecord[],
  headers: IncomingHttpHeaders,
  provider: Provider,
): AuthDecision {
  const token = presentedToken(headers);
  if (!token || !/^aar_[A-Za-z0-9_-]{43}$/.test(token)) {
    return { ok: false, status: 401, message: "missing or malformed gateway token" };
  }
  const presented = Buffer.from(hashGatewayToken(token), "hex");
  let found: GatewayClientRecord | undefined;
  for (const client of clients) {
    const stored = Buffer.from(client.tokenSha256, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = client;
  }
  if (!found || found.revokedAt) {
    return { ok: false, status: 401, message: "invalid or revoked gateway token" };
  }
  const accountId = found.accounts[provider];
  if (!accountId) {
    return { ok: false, status: 403, message: `gateway client is not permitted to use ${provider}` };
  }
  return { ok: true, client: found, accountId };
}
