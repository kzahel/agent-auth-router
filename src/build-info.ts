import { readFileSync } from "node:fs";
import { join } from "node:path";
export const BUILD_INFO: Readonly<Record<string, unknown>> = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "build.json"), "utf8"));
  } catch {
    return { version: "development", source: "unbundled" };
  }
})();
