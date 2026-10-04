import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { AccountConfig, Provider } from "./types.ts";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Bounded tail of stderr for diagnostics. Sanitize before logging. */
  stderrTail: string;
}

export interface BoundedProcess {
  child: ChildProcess;
  done: Promise<ProcessResult>;
  terminate(): void;
}

export interface StartOptions {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

const managed = new Set<BoundedProcess>();
let shuttingDown = false;
/** Called only when the CLI process itself is shutting down. */
export async function stopManagedProcesses(): Promise<void> {
  shuttingDown = true;
  while (managed.size) {
    const current = [...managed];
    for (const child of current) child.terminate();
    await Promise.all(current.map(child => child.done));
  }
}
/**
 * Spawns an approved executable with explicit argv (no shell), a caller-built
 * environment, a hard deadline and bounded retained output. The child gets
 * its own process group so termination also reaches its descendants.
 */
export function startBounded(options: StartOptions): BoundedProcess {
  if (shuttingDown) throw new Error("Router is shutting down");
  const maxStderr = options.maxStderrBytes ?? 16 * 1024;
  const graceMs = options.killGraceMs ?? 3_000;
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true,
  });

  let stderr = Buffer.alloc(0);
  child.stderr?.on("data", (chunk: Buffer) => {
    if (maxStderr === 0) return;
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxStderr) stderr = stderr.subarray(stderr.length - maxStderr);
  });

  let settled = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined || settled) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const terminate = () => {
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), graceMs);
    killTimer.unref();
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  deadline.unref();

  const done = new Promise<ProcessResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      // The process group can survive its leader; finish cancellation before
      // releasing ownership, even when descendants closed their output pipes.
      if (killTimer) signalGroup("SIGKILL");
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, timedOut, stderrTail: stderr.toString("utf8") });
    };
    child.on("error", (error) => {
      stderr = Buffer.from(`spawn failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`);
      finish(null, null);
    });
    child.on("close", finish);
  });

  const result = { child, done, terminate };
  managed.add(result);
  void done.then(() => managed.delete(result));
  return result;
}

const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

/**
 * Builds a helper environment from an allowlist, so router/client gateway
 * settings (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, OPENAI_BASE_URL,
 * CODEX_HOME of the caller, etc.) are absent by construction.
 */
export function helperEnv(provider: Provider, home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (provider === "codex") env.CODEX_HOME = home;
  else env.CLAUDE_CONFIG_DIR = home;
  return env;
}

/** Preserve normal Claude CLI Keychain identity when explicitly enrolled. */
export function accountEnv(account: AccountConfig, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = helperEnv(account.provider, account.home, source);
  if (account.credentialStore === "claude-keychain-default") {
    delete env.CLAUDE_CONFIG_DIR;
    env.HOME = dirname(account.home);
  }
  return env;
}
