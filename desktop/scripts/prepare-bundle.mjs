// Product runtime pins. Verify archives before extracting executable code.
import { createHash } from "node:crypto";
import { readdir, mkdir, mkdtemp, readFile, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "../..");
const architecture = process.env.AAR_BUNDLE_ARCH ?? process.arch;
const hashes = {
  arm64: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  x64: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
};
if (process.platform !== "darwin" || !hashes[architecture])
  throw new Error("Only the macOS packaging adapters are verified");
const version = "24.19.0",
  name = `node-v${version}-darwin-${architecture}`;
const resources = join(root, "desktop/resources");
const cache = join(root, "artifacts", `${name}.tar.gz`);
let archive;
try {
  archive = await readFile(cache);
} catch {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${name}.tar.gz`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(archive).digest("hex") !== hashes[architecture])
  throw new Error("Node archive checksum mismatch");
await mkdir(resolve(cache, ".."), { recursive: true });
await writeFile(cache, archive);
execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "aar-node-"));
try {
  execFileSync("tar", ["-xzf", cache, "-C", temp]);
  await cp(join(temp, name, "bin/node"), join(resources, "node"));
  await cp(join(temp, name, "LICENSE"), join(resources, "NODE-LICENSE"));
  await cp(join(root, "dist"), join(resources, "core"), { recursive: true });
  await writeFile(join(resources, "core/package.json"), '{"type":"module"}\n');
  await cp(join(root, "LICENSE"), join(resources, "LICENSE"));
  const config = JSON.parse(
    await readFile(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  const digest = createHash("sha256");
  for (const file of (await readdir(join(resources, "core"))).sort())
    digest.update(file).update(await readFile(join(resources, "core", file)));
  const manifest = {
    coreSha256: digest.digest("hex"),
    dirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    version: config.version,
    node: version,
    architecture,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    nodeArchiveSha256: hashes[architecture],
  };
  await writeFile(join(resources, "core/build.json"), JSON.stringify(manifest) + "\n");
  await writeFile(join(resources, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
