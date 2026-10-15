// Append-only JSONL event log for later analysis: quota observations,
// provider rejections, completed requests and binding decisions. Metadata
// only: no prompt or response content, credentials, token hashes or profile
// paths. Best effort: a failing log never affects a relay or an admission.

import { appendFileSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { DEFAULT_RETENTION_DAYS } from "./history.ts";
import { join } from "node:path";
import { errorText, log } from "./log.ts";
import { ensurePrivateDir } from "./state.ts";
import type { Provider } from "./types.ts";

export const EVENT_LOG_VERSION = 1;
/** The history default; a running router passes its configured retention. */
export const EVENT_RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_PENDING_LINES = 5_000;
const FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export type EventType = "router" | "quota" | "rejection" | "request" | "binding";

/** AAR_EVENT_LOG=0|false|off|no disables the log; anything else leaves it on. */
export function eventLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AAR_EVENT_LOG?.trim().toLowerCase();
  return !(value !== undefined && ["0", "false", "off", "no"].includes(value));
}

export class EventLog {
  readonly dir: string;
  private readonly now: () => number;
  private pending: string[] = [];
  private dropped = 0;
  private disabled = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(options: { dir: string; now?: () => number; retentionDays?: number | null }) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    try {
      ensurePrivateDir(this.dir);
      this.prune(options.retentionDays === undefined ? EVENT_RETENTION_DAYS : options.retentionDays);
    } catch (error) { this.disable("events.open_failed", error); }
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }
  /** Queues one line; `at` is added from the injected clock. */
  write(type: EventType, data: Record<string, unknown>): void {
    if (this.disabled) return;
    if (this.pending.length >= MAX_PENDING_LINES) { this.pending.shift(); this.dropped++; }
    this.pending.push(JSON.stringify({ v: EVENT_LOG_VERSION, type, at: new Date(this.now()).toISOString(), ...data }));
  }
  /** Today's file, by UTC date, so one day's analysis reads one file. */
  fileFor(time: number): string { return join(this.dir, `${new Date(time).toISOString().slice(0, 10)}.jsonl`); }
  flush(): void {
    if (this.disabled || !this.pending.length) return;
    const lines = this.pending;
    this.pending = [];
    if (this.dropped) { log("events.dropped", { lines: this.dropped }); this.dropped = 0; }
    const path = this.fileFor(this.now());
    try {
      if (!this.safe(path)) return;
      appendFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
    } catch (error) { this.disable("events.write_failed", error); }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
  /** An existing file must be a private regular file owned by this user. */
  private safe(path: string): boolean {
    let stat;
    try { stat = lstatSync(path); } catch { return true; }
    if (stat.isFile() && !stat.isSymbolicLink() && (process.platform === "win32" || (stat.uid === process.getuid?.() && !(stat.mode & 0o077)))) return true;
    this.disable("events.insecure_file", new Error(path));
    return false;
  }
  private disable(event: string, error: unknown): void {
    if (!this.disabled) log(event, { error: errorText(error) });
    this.disabled = true;
    this.pending = [];
  }
  /** Deletes day files older than the retention period; null keeps them forever. */
  prune(retentionDays: number | null): void {
    if (retentionDays === null) return;
    mkdirSync(this.dir, { recursive: true });
    const cutoff = this.now() - retentionDays * 86_400_000;
    for (const name of readdirSync(this.dir)) {
      const match = FILE.exec(name);
      if (!match) continue;
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (day < cutoff) { try { unlinkSync(join(this.dir, name)); } catch { /* best effort */ } }
    }
  }
}

const SESSION_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const CLAUDE_USER_ID = /"user_id"\s*:\s*"user_[0-9a-f]{64}_account_([0-9a-f-]{36})_session_([0-9a-f-]{36})"/;
const CLAUDE_USER_ID_JSON = /^"user_id"\s*:\s*"\{(?:[^"\\]|\\.)*?\\"session_id\\"\s*:\s*\\"([0-9a-f-]{36})\\"/;
const NEEDLE = Buffer.from('"user_id"');

/**
 * The client's own session identifier, so a request can be pinned to an
 * account and later joined to the CLI's rollout and Yep Anywhere metadata.
 * Codex sends a session_id header. Claude Code 2.1.291 sends
 * x-claude-code-session-id and embeds the same id in metadata.user_id, a JSON
 * string; older versions used `user_<hex>_account_<uuid>_session_<uuid>`
 * (docs/prototype.md). Only the id leaves this function, never the body.
 */
export function clientSessionId(provider: Provider, headers: Record<string, string | string[] | undefined>, body: Buffer): string | undefined {
  const header = provider === "codex" ? headers.session_id : headers["x-claude-code-session-id"];
  if (typeof header === "string" && SESSION_ID.test(header)) return header;
  if (provider === "codex") return undefined;
  const at = body.indexOf(NEEDLE);
  if (at < 0) return undefined;
  const window = body.subarray(at, at + 512).toString("latin1");
  return CLAUDE_USER_ID.exec(window)?.[2] ?? CLAUDE_USER_ID_JSON.exec(window)?.[1];
}
