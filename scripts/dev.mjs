// `npm run dev`: rebuild the UI whenever its source changes and run
// `aar serve --dev`, which reloads signed-in browsers after each rebuild.
// Extra arguments go to `aar serve`.
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shell = process.platform === "win32";
// One build first, so the router's watcher has a build to watch.
execFileSync("npm", ["--prefix", "ui", "run", "build", "--", "--logLevel", "warn"], { cwd: root, stdio: "inherit", shell });
const children = [
  spawn("npm", ["--prefix", "ui", "run", "watch", "--", "--logLevel", "warn", "--emptyOutDir", "false"], { cwd: root, stdio: "inherit", shell }),
  spawn(process.execPath, ["src/cli.ts", "serve", "--dev", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" }),
];
for (const child of children) {
  child.on("exit", (code, signal) => {
    for (const other of children) if (other !== child && other.exitCode === null) other.kill();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
// Ctrl-C reaches every process in the terminal's group; a signal sent to this
// script alone is passed on.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { for (const child of children) child.kill(signal); });
