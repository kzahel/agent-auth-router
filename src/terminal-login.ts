// Interactive official CLI authentication. Only the terminal sees provider output.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { ownerRequest } from "./owner.ts";
import { providerExecutable } from "./platform.ts";
import { accountEnv } from "./process.ts";
import type { StateStore } from "./state.ts";
import type { AccountConfig } from "./types.ts";

export function loginArgs(provider: AccountConfig["provider"], choice: string): string[] {
  if (provider === "codex" && choice === "1") return ["login"];
  if (provider === "codex" && choice === "2") return ["login", "--device-auth"];
  if (provider === "claude" && choice === "1") return ["auth", "login", "--claudeai"];
  if (provider === "claude" && choice === "2") return ["auth", "login", "--claudeai", "--sso"];
  throw new Error("Choose 1 or 2, or press Ctrl-C to cancel.");
}
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function signal(pid: number | undefined, value: NodeJS.Signals): void {
  if (pid) try { process.kill(pid, value); } catch {}
}

/** Owner-only lease. Serializes terminal login with renewal and core lifecycle. */
export class TerminalLogin {
  readonly token = randomUUID();
  status: "running" | "complete" | "failed" | "cancelled" = "running";
  private childPid: number | undefined;
  private readonly timer: NodeJS.Timeout;
  private killAt = 0;
  private finished = false;
  private readonly deadline = Date.now() + 10 * 60_000;
  private readonly runnerPid: number;
  private readonly release: () => void;
  constructor(runnerPid: number, release: () => void) {
    this.runnerPid = runnerPid; this.release = release;
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
  }
  attach(pid: number): void {
    if (this.finished || this.killAt || this.childPid !== undefined) throw new Error("Terminal sign-in is no longer available");
    this.childPid = pid;
  }
  busy(): boolean { return !this.finished; }
  cancel(): void {
    if (this.finished || this.killAt) return;
    this.status = "cancelled";
    this.killAt = Date.now() + 3000;
    signal(this.childPid, "SIGTERM");
    signal(this.runnerPid, "SIGTERM");
  }
  end(success: boolean): void {
    // The runner waits for its CLI child to exit before releasing the lease.
    if (alive(this.childPid)) throw new Error("Official CLI is still running");
    if (this.status === "running") this.status = success ? "complete" : "failed";
    this.finish();
  }
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.release();
  }
  private tick(): void {
    if (!alive(this.runnerPid) || Date.now() >= this.deadline) this.cancel();
    if (this.killAt && Date.now() >= this.killAt) {
      signal(this.childPid, "SIGKILL");
      signal(this.runnerPid, "SIGKILL");
    }
    if (this.killAt && !alive(this.childPid) && !alive(this.runnerPid)) this.finish();
  }
  async close(): Promise<void> {
    this.cancel();
    while (this.busy()) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function terminalLogin(store: StateStore, id: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Sign-in requires an interactive terminal");
  const account = store.loadAccounts().find(a => a.id === id);
  if (!account) throw new Error("Account not found");
  const lease = await ownerRequest(store, "accounts/terminal-begin", { id, pid: process.pid });
  const body = { id, token: lease.token };
  let child: ChildProcess | undefined, cancelled = false, success = false, choosing = true;
  const abort = new AbortController();
  const cancel = () => { cancelled = true; child?.kill("SIGTERM"); abort.abort(); };
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.on("SIGINT", cancel);
  input.on("close", () => { if (choosing) cancel(); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, cancel);
  const heartbeat = setInterval(() => {
    void ownerRequest(store, "accounts/terminal-status", body).then(value => {
      if (value.status !== "running") cancel();
    }, cancel);
  }, 1000);
  const deadline = setTimeout(cancel, 10 * 60_000);
  try {
    process.stdout.write(`\n${account.provider} sign-in\nProfile: ${account.home}\n\n`);
    process.stdout.write(account.provider === "codex"
      ? "1. Browser sign-in\n2. Device code\n"
      : "1. Claude subscription sign-in\n2. Organization SSO\n");
    let args: string[] | undefined;
    while (!cancelled && !args) {
      try { args = loginArgs(account.provider, (await input.question("Choose [1/2]: ", { signal: abort.signal })).trim() || "1"); }
      catch (error) { if (!cancelled) process.stdout.write(`${(error as Error).message}\n`); }
    }
    choosing = false;
    input.close();
    if (cancelled || !args) return;
    // Keep the official CLI in Terminal's foreground process group with real TTY fds.
    child = spawn(providerExecutable(account.provider), args, {
      env: { ...accountEnv(account), TERM: process.env.TERM ?? "xterm-256color" },
      cwd: account.home, stdio: "inherit", shell: false,
    });
    const done = new Promise<number | null>((resolve) => {
      child!.once("error", () => resolve(null));
      child!.once("close", resolve);
    });
    const kill = setInterval(() => { if (cancelled) child?.kill("SIGKILL"); }, 3000);
    try {
      if (child.pid) await ownerRequest(store, "accounts/terminal-attach", { ...body, pid: child.pid });
      success = (await done) === 0 && !cancelled;
    } finally {
      cancelled ||= !success;
      child.kill("SIGTERM");
      await done;
      clearInterval(kill);
    }
  } finally {
    input.close(); clearInterval(heartbeat); clearTimeout(deadline);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, cancel);
    await ownerRequest(store, "accounts/terminal-end", { ...body, success }).catch(() => {});
    process.stdout.write(success ? "\nSign-in command finished. Check sign-in in Agent Auth Router.\n" : "\nSign-in stopped or failed.\n");
  }
}
