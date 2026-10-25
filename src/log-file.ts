// A persistent copy of the router's structured log: the same metadata-only,
// sanitized lines that go to stderr, in <state>/logs/router-<UTC date>.log,
// so what led up to a crash survives without a terminal's scrollback.

import { closeSync, constants, fstatSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorText, setLogSink } from "./log.ts";
import { ensurePrivateDir } from "./state.ts";

export const LOG_RETENTION_DAYS = 7;
const FILE = /^router-(\d{4})-(\d{2})-(\d{2})\.log$/;

/** AAR_LOG_FILE=0|false|off|no disables the file; anything else leaves it on. */
export function logFileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AAR_LOG_FILE?.trim().toLowerCase();
  return !(value !== undefined && ["0", "false", "off", "no"].includes(value));
}

export function logsDir(stateDir: string): string { return join(stateDir, "logs"); }

/** Log file names in date order, oldest first. */
export function logFiles(dir: string): string[] {
  try { return readdirSync(dir).filter(name => FILE.test(name)).sort(); } catch { return []; }
}

export class LogFile {
  readonly dir: string;
  private readonly now: () => number;
  private readonly retentionDays: number;
  private fd: number | undefined;
  private path: string | undefined;
  constructor(options: { dir: string; now?: () => number; retentionDays?: number }) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  }
  pathFor(time: number): string { return join(this.dir, `router-${new Date(time).toISOString().slice(0, 10)}.log`); }
  /** Appends one line synchronously, so a line logged just before exit is kept. Throws on failure. */
  write(line: string): void {
    const path = this.pathFor(this.now());
    if (path !== this.path) this.open(path);
    writeSync(this.fd!, line + "\n");
  }
  close(): void {
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* already closed */ } }
    this.fd = undefined;
    this.path = undefined;
  }
  /** Deletes day files older than the retention period. */
  prune(): void {
    const cutoff = this.now() - this.retentionDays * 86_400_000;
    for (const name of logFiles(this.dir)) {
      const match = FILE.exec(name)!;
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (day < cutoff) { try { unlinkSync(join(this.dir, name)); } catch { /* best effort */ } }
    }
  }
  private open(path: string): void {
    this.close();
    ensurePrivateDir(this.dir);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || stat.mode & 0o077))) {
      closeSync(fd);
      throw new Error("log file is not a private regular file");
    }
    this.fd = fd;
    this.path = path;
    this.prune();
  }
}

/**
 * Tees every log line into the state directory's log file. A failing file is
 * reported once on the previous sink and then skipped; logging to stderr
 * never stops.
 */
export function installLogFile(stateDir: string, env: NodeJS.ProcessEnv = process.env): LogFile | undefined {
  if (!logFileEnabled(env)) return undefined;
  const file = new LogFile({ dir: logsDir(stateDir) });
  let failed = false;
  const previous = setLogSink(line => {
    previous(line);
    if (failed) return;
    try { file.write(line); } catch (error) {
      failed = true;
      file.close();
      previous(JSON.stringify({ ts: new Date().toISOString(), event: "log_file.failed", error: errorText(error) }));
    }
  });
  return file;
}
