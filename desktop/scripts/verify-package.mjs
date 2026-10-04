import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const app = resolve(process.argv[2]),
  resource = join(app, "Contents/Resources/resources"),
  core = join(resource, "core");
const build = JSON.parse(readFileSync(join(resource, "build.json"), "utf8"));
assert.deepEqual(JSON.parse(readFileSync(join(core, "build.json"), "utf8")), build);
const digest = createHash("sha256");
for (const file of readdirSync(core)
  .filter((f) => f !== "build.json")
  .sort())
  digest.update(file).update(readFileSync(join(core, file)));
assert.equal(digest.digest("hex"), build.coreSha256);
const appVersion = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print CFBundleShortVersionString", join(app, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
assert.equal(appVersion, build.version);
const minimumMacOS = execFileSync("/usr/libexec/PlistBuddy", [
  "-c", "Print LSMinimumSystemVersion", join(app, "Contents/Info.plist"),
], { encoding: "utf8" }).trim();
const nodeMinimumMacOS = execFileSync("vtool", ["-show-build", join(resource, "node")], {
  encoding: "utf8",
}).match(/\bminos\s+([\d.]+)/)?.[1];
assert.ok(nodeMinimumMacOS, "bundled Node must declare its minimum macOS version");
const versionNumber = (v) => v.split(".").concat("0", "0").slice(0, 3).reduce((n, part) => n * 1000 + Number(part), 0);
assert.ok(versionNumber(minimumMacOS) >= versionNumber(nodeMinimumMacOS), "app minimum macOS must support bundled Node");
const arch = execFileSync("lipo", ["-archs", join(resource, "node")], { encoding: "utf8" }).trim();
assert.equal(arch, build.architecture === "x64" ? "x86_64" : build.architecture);
assert.equal(
  execFileSync("lipo", ["-archs", join(app, "Contents/MacOS/agent-auth-router-desktop")], {
    encoding: "utf8",
  }).trim(),
  arch,
);
if ((process.arch === "x64" ? "x86_64" : process.arch) === arch) {
  assert.equal(
    execFileSync(join(resource, "node"), ["--version"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    }).trim(),
    `v${build.node}`,
  );
  execFileSync(join(resource, "node"), [join(core, "cli.js"), "--help"], {
    env: { PATH: "/usr/bin:/bin" },
  });
}
for (const name of ["NODE-LICENSE", "LICENSE", "PORTABLE-PTY-LICENSE"])
  assert.ok(readFileSync(join(resource, name)).length);
if (process.argv.includes("--signed")) {
  const team = process.env.APPLE_TEAM_ID;
  assert.ok(team, "expected signing team required");
  for (const path of [join(resource, "node"), app])
    execFileSync("codesign", [
      "--verify",
      "--strict",
      "-R",
      `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
      path,
    ]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  execFileSync("xcrun", ["stapler", "validate", app]);
  execFileSync("spctl", ["--assess", "--type", "execute", app]);
}
console.log(
  JSON.stringify(
    { ...build, appVersion, arch, minimumMacOS, nodeMinimumMacOS, signed: process.argv.includes("--signed") },
    null,
    2,
  ),
);
