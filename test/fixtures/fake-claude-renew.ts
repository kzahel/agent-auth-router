// Stand-in for a Claude renewal command. Usage: node fake-claude-renew.ts <mode>
// Modes: renew | unchanged | fail | hang | hang-with-child
import { spawn } from "node:child_process";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "renew";
const home: string =
  process.env.CLAUDE_CONFIG_DIR ??
  (process.stderr.write("CLAUDE_CONFIG_DIR missing\n"), process.exit(3));
appendFileSync(join(home, "helper-log.jsonl"), JSON.stringify({ pid: process.pid, mode, env: Object.keys(process.env).sort() }) + "\n");

if (mode === "fail") {
  process.stderr.write("refresh failed: access_token=SECRET-LEAK-in-stderr\n");
  process.exit(4);
}
if (mode === "hang" || mode === "hang-with-child") {
  if (mode === "hang-with-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(join(home, "child.pid"), String(child.pid));
  }
  setInterval(() => {}, 1000);
} else {
  if (mode === "renew") {
    const credentials = {
      claudeAiOauth: { accessToken: `renewed-${Date.now()}`, refreshToken: "SECRET-REFRESH-renewed", expiresAt: Date.now() + 3600_000 },
    };
    writeFileSync(join(home, ".credentials.json.tmp"), JSON.stringify(credentials));
    renameSync(join(home, ".credentials.json.tmp"), join(home, ".credentials.json"));
  }
  process.exit(0);
}
