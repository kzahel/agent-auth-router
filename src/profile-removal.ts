// Folder deletion is deliberately narrower than enrollment: only router-managed
// direct children, never imported homes, aliases, shared ancestors or mounts.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { ControlError, assertPrivatePath } from "./control.ts";
import { physicalHome } from "./profiles.ts";
import type { StateStore } from "./state.ts";
import type { AccountConfig } from "./types.ts";

export function profileRemoval(store: StateStore, account: AccountConfig) {
  const unavailable = (reason: string) => ({ canDeleteProfile: false, deleteIdentity: null, reason });
  if (account.enrollment === "existing") return unavailable("Imported profiles are kept. Delete their files separately if you no longer need them in your CLI.");
  if (dirname(resolve(account.home)) !== resolve(store.profilesDir)) return unavailable("Only dedicated folders inside the router's profiles folder can be deleted here.");
  try {
    assertPrivatePath(store.profilesDir);
    const stat = lstatSync(account.home);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return unavailable("The profile folder's type or owner changed. Its files will be kept.");
    if (stat.dev !== lstatSync(store.profilesDir).dev) return unavailable("The profile folder is on another filesystem. Delete its files separately.");
    const home = realpathSync(account.home), parent = realpathSync(store.profilesDir);
    if (dirname(home) !== parent) return unavailable("The profile folder is an alias. Its files will be kept.");
    if (store.loadAccounts().some(a => a.id !== account.id && (physicalHome(a.home) === home || physicalHome(a.home).startsWith(home + sep)))) return unavailable("Another enrolled profile uses this folder. Its files will be kept.");
    return { canDeleteProfile: true, deleteIdentity: `${stat.dev}:${stat.ino}`, reason: "Permanently deletes this folder and everything inside it, including file credentials, settings and history. Keychain credentials are not deleted." };
  } catch {
    return unavailable("The profile folder is missing or cannot be safely inspected. Remove will keep any files.");
  }
}

export function deleteProfile(store: StateStore, account: AccountConfig, identity: string): void {
  const current = profileRemoval(store, account);
  if (!current.canDeleteProfile || current.deleteIdentity !== identity) throw new ControlError(409, "Profile folder changed; reopen the Remove dialog.");
  // Do not traverse mounted directories; symlinks inside the folder are removed
  // as links, never followed by either inspection or recursive rm.
  const device = lstatSync(account.home).dev;
  const check = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.dev !== device) throw new ControlError(409, "Profile contains a mounted directory; delete it separately.");
    if (stat.isDirectory()) for (const name of readdirSync(path)) check(`${path}${sep}${name}`);
  };
  check(account.home);
  rmSync(account.home, { recursive: true });
}
