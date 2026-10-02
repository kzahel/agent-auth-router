// Version-specific, read-only readers for provider-owned credential stores.
//
// The formats below are source observations, not supported interfaces:
// - Codex file storage: `$CODEX_HOME/auth.json` with `tokens.access_token`
//   and `tokens.account_id` (openai/codex codex-rs/login, see docs/sources.md).
// - Claude Code file storage: `$CLAUDE_CONFIG_DIR/.credentials.json` with
//   `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` (epoch ms).
//   On macOS Claude Code normally uses the Keychain instead; no Keychain
//   reader exists yet.
//
// Readers never write, repair or truncate the store, and never return
// refresh tokens.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider, UpstreamCredential } from "./types.ts";

export type ReadResult =
  | { status: "ok"; credential: UpstreamCredential }
  | { status: "missing"; reason: string }
  | { status: "unsupported"; reason: string }
  | { status: "malformed"; reason: string };

export type CredentialReader = () => Promise<ReadResult>;

export function credentialReaderFor(provider: Provider, home: string): CredentialReader {
  return provider === "codex" ? () => readCodexFile(home) : () => readClaudeFile(home);
}

const REPLACEMENT_RETRY_MS = 50;

type JsonResult = { status: "json"; value: unknown } | Exclude<ReadResult, { status: "ok" }>;

async function readJson(path: string): Promise<JsonResult> {
  for (let attempt = 0; ; attempt++) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing", reason: "credential file not found" };
      }
      return { status: "malformed", reason: `credential file unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    try {
      return { status: "json", value: JSON.parse(text) };
    } catch {
      // A writer that replaces the file non-atomically can expose a partial
      // document briefly. Retry once before reporting malformed state.
      if (attempt >= 1) return { status: "malformed", reason: "credential file is not valid JSON" };
      await new Promise((resolve) => setTimeout(resolve, REPLACEMENT_RETRY_MS));
    }
  }
}

function revisionOf(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Reads `exp` from a JWT payload for scheduling only; no signature check. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export async function readCodexFile(home: string): Promise<ReadResult> {
  const parsed = await readJson(join(home, "auth.json"));
  if (parsed.status !== "json") {
    if (parsed.status === "missing" && (await codexUsesNonFileStore(home))) {
      return { status: "unsupported", reason: "profile uses a non-file Codex credential store" };
    }
    return parsed;
  }
  const tokens = record(record(parsed.value)?.tokens);
  if (!tokens) {
    return { status: "unsupported", reason: "profile has no ChatGPT tokens (API-key or other auth mode)" };
  }
  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "malformed", reason: "ChatGPT access token absent" };
  }
  const accountId = typeof tokens.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
  return {
    status: "ok",
    credential: { accessToken, expiresAt: jwtExpiryMs(accessToken), accountId, revision: revisionOf(accessToken) },
  };
}

async function codexUsesNonFileStore(home: string): Promise<boolean> {
  try {
    const config = await readFile(join(home, "config.toml"), "utf8");
    const match = /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m.exec(config);
    return match !== null && match[1] !== "file";
  } catch {
    return false;
  }
}

export async function readClaudeFile(home: string): Promise<ReadResult> {
  const parsed = await readJson(join(home, ".credentials.json"));
  if (parsed.status !== "json") {
    if (parsed.status === "missing" && process.platform === "darwin") {
      return { status: "unsupported", reason: "no credential file; macOS Keychain storage is not readable yet" };
    }
    return parsed;
  }
  const oauth = record(record(parsed.value)?.claudeAiOauth);
  if (!oauth) return { status: "unsupported", reason: "profile has no Claude subscription OAuth credential" };
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    return { status: "malformed", reason: "Claude access token absent" };
  }
  const expiresAt = typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : undefined;
  return {
    status: "ok",
    credential: { accessToken, expiresAt, accountId: undefined, revision: revisionOf(accessToken) },
  };
}
