// Owner-only profile discovery and inspection. Never provisions an existing home.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { credentialReaderFor, type CredentialReader } from "./credentials.ts";
import { directProviderProblem } from "./helpers.ts";
import { ControlError } from "./control.ts";
import type { AccountConfig, Provider } from "./types.ts";

export function profileHome(value: unknown): string {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new ControlError(400, "Choose an absolute profile folder");
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new ControlError(400, "Choose an absolute profile folder");
  return resolve(path);
}
export function physicalHome(home: string): string {
  try { return realpathSync(home); } catch { return resolve(home); }
}
export function discoverProfiles(provider: Provider, userHome = homedir(), env = process.env) {
  const candidates = [
    { home: join(userHome, provider === "codex" ? ".codex" : ".claude"), source: "Normal CLI profile" },
    { home: env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"], source: "Environment profile" },
  ];
  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    if (!candidate.home || !isAbsolute(candidate.home)) return [];
    const home = resolve(candidate.home), key = physicalHome(home);
    try { if (!statSync(home).isDirectory() || seen.has(key)) return []; } catch { return []; }
    seen.add(key);
    return [{ home, source: candidate.source }];
  });
}
export function profileStore(provider: Provider, home: string, value: unknown): NonNullable<AccountConfig["credentialStore"]> {
  const store = value === undefined || value === "auto"
    ? provider === "claude" && process.platform === "darwin"
      ? home === join(homedir(), ".claude") ? "claude-keychain-default" : "claude-keychain"
      : "file"
    : value;
  if (store !== "file" && store !== "claude-keychain" && store !== "claude-keychain-default") throw new ControlError(400, "Unsupported credential store");
  if (store !== "file" && (provider !== "claude" || process.platform !== "darwin")) throw new ControlError(400, "Claude Keychain requires macOS and Claude");
  if (store === "claude-keychain-default" && home !== join(homedir(), ".claude")) throw new ControlError(400, "Normal CLI Keychain requires the normal Claude profile folder");
  return store;
}
export async function inspectProfile(account: AccountConfig, read: CredentialReader = credentialReaderFor(account.provider, account.home, account.credentialStore)) {
  try { if (!statSync(account.home).isDirectory()) throw new Error(); }
  catch { throw new ControlError(400, "Existing profile folder is missing or unreadable"); }
  const problem = await directProviderProblem({ account, workDir: account.home });
  if (problem) return { home: account.home, credentialStore: account.credentialStore, canEnroll: false, credentialStatus: "unsupported", detail: problem };
  const result = await read();
  return {
    home: account.home, credentialStore: account.credentialStore,
    canEnroll: result.status === "ok" || result.status === "missing",
    credentialStatus: result.status === "ok" && result.credential.expiresAt !== undefined && result.credential.expiresAt <= Date.now() ? "expired" : result.status,
    expiresAt: result.status === "ok" && result.credential.expiresAt !== undefined ? new Date(result.credential.expiresAt).toISOString() : null,
    detail: result.status === "ok" ? "Stored credentials readable; provider access is not checked" : result.reason,
  };
}
