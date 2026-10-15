// Two pages: the management UI (desktop window and web dashboard) and the
// desktop's sign-in terminal window. The build's manifest tells the web
// dashboard which files the management page needs, so terminal-only assets
// stay unserved. A relative base serves the same files from the Tauri asset
// protocol and the loopback dashboard.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
// Bundled packages whose license notices ship with the build.
const LICENSED = ["@xterm/xterm", "@xterm/addon-fit"];

function licenses(): Plugin {
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle() {
      const text = LICENSED.map(name => {
        const dir = dirname(require.resolve(`${name}/package.json`));
        const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        return `${name}@${version}\n\n${readFileSync(join(dir, "LICENSE"), "utf8").trim()}\n`;
      }).join("\n---\n\n");
      this.emitFile({ type: "asset", fileName: "third-party-licenses.txt", source: text });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [licenses()],
  build: {
    manifest: true,
    // The desktop WebView and current browsers support module preloading.
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: "index.html", terminal: "terminal.html" } },
  },
  test: { environment: "jsdom" },
});
