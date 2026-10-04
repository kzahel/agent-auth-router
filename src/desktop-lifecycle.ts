// Desktop startup recovery only: never replace a live, foreign or non-socket endpoint.
import { lstatSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import { assertPrivatePath } from "./control.ts";
import type { StateStore } from "./state.ts";

async function refused(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
  });
}
export async function recoverDesktopSocket(store: StateStore): Promise<void> {
  const path = join(store.dir, "control.sock");
  let before;
  try { before = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  assertPrivatePath(store.dir);
  assertPrivatePath(path, true);
  if (!await refused(path)) throw new Error("control socket is active or unavailable");
  await new Promise(resolve => setTimeout(resolve, 100));
  if (!await refused(path)) throw new Error("control socket is active or unavailable");
  const after = lstatSync(path);
  if (after.ino !== before.ino || after.dev !== before.dev || after.mode !== before.mode || after.uid !== before.uid) throw new Error("control socket changed during recovery");
  // Preserve the abandoned inode for inspection instead of deleting user state.
  renameSync(path, `${path}.stale-${randomUUID()}`);
}
export function desktopStartupError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") return "The router's listening address is already in use. Close the conflicting process and Reload.";
  if (code === "EACCES" || code === "EPERM") return "The router cannot access its state folder or listening address. Check its permissions and Reload.";
  if (error instanceof SyntaxError) return "A router settings or account file contains invalid JSON. Correct the file and Reload.";
  const message = error instanceof Error ? error.message : "";
  if (/control socket.*(active|exists|changed|unavailable)/.test(message)) return "The control socket is active or changed during startup. Reload after the other router has stopped.";
  if (/control endpoint must be private/.test(message)) return "The control endpoint has an unexpected type, owner or permissions. It was left untouched.";
  if (/control socket path too long/.test(message)) return "The router state folder path is too long for local communication.";
  if (/unsupported .*version|invalid|must be|unknown upstream/.test(message)) return "Router settings or account configuration are invalid or incompatible. Check the configuration and Reload.";
  return "The router failed to initialize. Check its state folder and configuration, then Reload.";
}
