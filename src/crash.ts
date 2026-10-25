// Crash records: a sanitized account of each time the router process died
// unexpectedly, kept in <state>/crashes.json so the next router can show them
// until the owner acknowledges them. Restarting keeps the router available;
// these records keep the crash from passing unnoticed.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILD_INFO } from "./build-info.ts";
import { log, sanitize } from "./log.ts";
import { writePrivateJson } from "./state.ts";

/** Exit status of a router that recorded its own crash. */
export const CRASH_EXIT_CODE = 70;
const MAX_RECORDS = 50;
const MAX_FRAMES = 12;

export interface CrashRecord {
  id: string;
  at: string;
  pid: number | null;
  /** `exception`: the router recorded an uncaught error. `exit`: its supervisor saw it die. */
  kind: "exception" | "exit";
  origin?: string;
  code?: string;
  message: string;
  /** Stack frames, sanitized, with the home directory shown as `~`. */
  stack?: string[];
  exitCode?: number | null;
  signal?: string | null;
  build: string;
  node: string;
}

/** What the overview shows: no stack beyond the frame that threw. */
export type CrashSummary = Pick<CrashRecord, "id" | "at" | "kind" | "code" | "message"> & { frame?: string };

interface CrashFile { version: 1; acknowledgedThrough: string | null; crashes: CrashRecord[] }

export function crashesPath(stateDir: string): string { return join(stateDir, "crashes.json"); }

function scrub(text: string): string {
  const home = homedir();
  return sanitize(text.replaceAll("file://", "").replaceAll(home, "~"));
}

const build = () => `${String(BUILD_INFO.version ?? "unknown")}${BUILD_INFO.source === "unbundled" ? " (unbundled)" : ""}`;

export function crashFromError(error: unknown, origin: string, now: () => number = Date.now): CrashRecord {
  const failure = error instanceof Error ? error : undefined;
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  const stack = failure?.stack?.split("\n").map(line => line.trim()).filter(line => line.startsWith("at ")).slice(0, MAX_FRAMES).map(scrub);
  return {
    id: randomUUID(), at: new Date(now()).toISOString(), pid: process.pid, kind: "exception", origin,
    ...(typeof code === "string" ? { code: sanitize(code) } : {}),
    message: scrub(failure ? `${failure.name}: ${failure.message}` : String(error)),
    ...(stack?.length ? { stack } : {}),
    build: build(), node: process.version,
  };
}

export function crashFromExit(exitCode: number | null, signal: string | null, pid: number | null, now: () => number = Date.now): CrashRecord {
  return {
    id: randomUUID(), at: new Date(now()).toISOString(), pid, kind: "exit",
    message: signal ? `router stopped by ${signal}` : `router exited with status ${exitCode}`,
    exitCode, signal, build: build(), node: process.version,
  };
}

function load(stateDir: string): CrashFile {
  const path = crashesPath(stateDir);
  if (!existsSync(path)) return { version: 1, acknowledgedThrough: null, crashes: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CrashFile>;
    return { version: 1, acknowledgedThrough: typeof value.acknowledgedThrough === "string" ? value.acknowledgedThrough : null, crashes: Array.isArray(value.crashes) ? value.crashes : [] };
  } catch { return { version: 1, acknowledgedThrough: null, crashes: [] }; }
}

/** Synchronous, so it completes inside an exception handler that exits next. */
export function recordCrash(stateDir: string, record: CrashRecord): void {
  const file = load(stateDir);
  file.crashes = [...file.crashes, record].slice(-MAX_RECORDS);
  writePrivateJson(crashesPath(stateDir), file);
}

/** All kept records, oldest first. */
export function readCrashes(stateDir: string): CrashRecord[] { return load(stateDir).crashes; }

export function unacknowledgedCrashes(stateDir: string): CrashRecord[] {
  const { acknowledgedThrough, crashes } = load(stateDir);
  return acknowledgedThrough === null ? crashes : crashes.filter(crash => crash.at > acknowledgedThrough);
}

export function summarize(crash: CrashRecord): CrashSummary {
  return { id: crash.id, at: crash.at, kind: crash.kind, ...(crash.code ? { code: crash.code } : {}), message: crash.message, ...(crash.stack?.[0] ? { frame: crash.stack[0] } : {}) };
}

/** Acknowledges the named crash and every earlier one; a later crash stays visible. */
export function acknowledgeCrashes(stateDir: string, throughId: string): boolean {
  const file = load(stateDir);
  const crash = file.crashes.find(candidate => candidate.id === throughId);
  if (!crash) return false;
  if (file.acknowledgedThrough === null || crash.at > file.acknowledgedThrough) {
    file.acknowledgedThrough = crash.at;
    writePrivateJson(crashesPath(stateDir), file);
  }
  return true;
}

export function formatCrash(crash: CrashRecord): string {
  return [`${crash.at}  ${crash.message}${crash.code ? ` [${crash.code}]` : ""}  (build ${crash.build}, node ${crash.node}, pid ${crash.pid ?? "unknown"})`,
    ...(crash.stack ?? []).map(frame => `    ${frame}`)].join("\n");
}

/**
 * Records an uncaught exception or unhandled rejection, then exits with
 * CRASH_EXIT_CODE. The router never keeps running after one: its state may
 * be inconsistent. `flush` saves buffered state such as the event log.
 */
export function installCrashHandler(stateDir: string, flush?: () => void): void {
  process.on("uncaughtException", (error, origin) => {
    try {
      const record = crashFromError(error, origin);
      process.stderr.write(`aar: router crashed\n${formatCrash(record)}\n`);
      log("router.crash", { origin, code: record.code, error: record.message, frame: record.stack?.[0] });
      recordCrash(stateDir, record);
      flush?.();
    } catch { /* exiting matters more than the record */ }
    process.exit(CRASH_EXIT_CODE);
  });
}
