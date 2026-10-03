import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const pin = JSON.parse(
  readFileSync(new URL("./pin.json", import.meta.url), "utf8"),
);
const checkout = resolve(root, "artifacts/yepanywhere");
const run = (command, args, cwd = checkout) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
const git = (...args) =>
  execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(pin.revision))
  throw new Error("YA revision must be a full commit SHA");
if (!existsSync(checkout)) {
  mkdirSync(checkout, { recursive: true });
  run("git", ["init"]);
  run("git", ["remote", "add", "origin", pin.repository]);
}
if (git("remote", "get-url", "origin") !== pin.repository)
  throw new Error("Unexpected YA checkout origin");
if (git("status", "--porcelain", "--untracked-files=normal"))
  throw new Error("YA fixture checkout is dirty; refusing to overwrite it");
run("git", ["fetch", "--depth=1", "origin", pin.revision]);
run("git", ["checkout", "--detach", pin.revision]);
if (git("rev-parse", "HEAD") !== pin.revision)
  throw new Error("YA revision mismatch");
const manifest = JSON.parse(
  readFileSync(resolve(checkout, "package.json"), "utf8"),
);
if (manifest.packageManager !== pin.packageManager)
  throw new Error("Pinned package manager disagrees with YA");
// Use YA's own frozen lockfile and install-script allowlist. No YA sources are patched.
run("npm", [
  "exec",
  "--yes",
  `--package=${pin.packageManager}`,
  "--",
  "pnpm",
  "install",
  "--frozen-lockfile",
]);
run("npm", [
  "exec",
  "--yes",
  `--package=${pin.packageManager}`,
  "--",
  "pnpm",
  "--filter",
  "@yep-anywhere/shared",
  "build",
]);
