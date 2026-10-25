// The `aar serve` parent. It runs the router as a child process so
// `aar restart` can load the current code in place, and starts the router
// again after a crash. Every crash is recorded; repeated crashes stop it.

import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants as osConstants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CRASH_EXIT_CODE, crashFromExit, recordCrash } from "./crash.ts";

/** Exit status asking the `aar serve` parent to start the router again. */
export const RESTART_EXIT_CODE = 75;
/** This many crashes within the window stop restarting. */
export const CRASH_LIMIT = 5;
export const CRASH_WINDOW_MS = 5 * 60_000;
/** IPC message a router child sends once it is serving. */
export const READY_MESSAGE = "aar:ready";

/** 1, 2, 4 and 8 seconds for the first to fourth crash in the window. */
export function restartDelayMs(recentCrashes: number): number {
  return Math.min(30_000, 1000 * 2 ** (recentCrashes - 1));
}

export interface SupervisorOptions {
  spawn(): ChildProcess;
  stateDir: string;
  now?: () => number;
  write?: (text: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Ctrl-C reaches both processes; the parent forwards signals, never restarts
 * after one, and exits with the router's status. A child that exits before it
 * is serving is a startup failure, which is not retried.
 */
export class Supervisor {
  private readonly options: SupervisorOptions;
  private readonly stopped = new AbortController();
  private child: ChildProcess | undefined;
  private crashes: number[] = [];
  constructor(options: SupervisorOptions) { this.options = options; }

  stop(signal: NodeJS.Signals): void {
    this.stopped.abort();
    this.child?.kill(signal);
  }

  async run(): Promise<number> {
    const now = this.options.now ?? Date.now;
    const write = this.options.write ?? (text => process.stdout.write(text));
    const sleep = this.options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined));
    for (;;) {
      const child = this.child = this.options.spawn();
      let ready = false;
      child.on("message", message => { if (message === READY_MESSAGE) ready = true; });
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      this.child = undefined;
      const status = code ?? (signal ? 128 + osConstants.signals[signal] : 1);
      if (this.stopped.signal.aborted) return status;
      if (code === RESTART_EXIT_CODE) { write("aar: starting the router again\n"); continue; }
      if (code === 0 || !ready) return status;

      if (code !== CRASH_EXIT_CODE) {
        try { recordCrash(this.options.stateDir, crashFromExit(code, signal, child.pid ?? null, now)); }
        catch { write("aar: could not record the crash\n"); }
      }
      const at = now();
      this.crashes = [...this.crashes.filter(time => at - time < CRASH_WINDOW_MS), at];
      if (this.crashes.length >= CRASH_LIMIT) {
        write(`aar: the router crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 60_000} minutes; not starting it again. See \`aar logs --crashes\`.\n`);
        return status;
      }
      const wait = restartDelayMs(this.crashes.length);
      write(`aar: the router crashed; starting it again in ${wait / 1000}s. See \`aar logs --crashes\`.\n`);
      await sleep(wait, this.stopped.signal);
      if (this.stopped.signal.aborted) return 0;
    }
  }
}
