// Provider discovery is an OS adapter, separate from account/pool policy.
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Provider } from "./types.ts";
export function providerExecutable(
  provider: Provider,
  home = homedir(),
  path = process.env.PATH ?? "",
): string {
  const directories = path.split(delimiter).filter(Boolean);
  if (process.platform !== "win32") {
    directories.push(
      join(home, ".local/bin"),
      join(home, ".npm-global/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
    // Finder does not inherit a shell's nvm initialization.
    try {
      directories.push(
        ...readdirSync(join(home, ".nvm/versions/node"))
          .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map((v) => join(home, ".nvm/versions/node", v, "bin")),
      );
    } catch {}
  }
  for (const directory of directories) {
    const file = join(directory, provider);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return provider; // spawn emits a bounded unavailable result when absent.
}
