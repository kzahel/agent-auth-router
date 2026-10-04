// Bundle pinned terminal assets locally; no CDN or runtime downloads.
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "ui/vendor"), { recursive: true });
for (const [source, target] of [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/xterm/LICENSE", "XTERM-LICENSE"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-fit/LICENSE", "XTERM-FIT-LICENSE"],
]) await copyFile(resolve(root, "node_modules", source), resolve(root, "ui/vendor", target));
