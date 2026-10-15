// Manual agent/tmux rehearsal only. This is a synthetic provider, not a login
// driver: it never sends input or contacts a provider. No real credentials.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const provider = process.argv[2];
if (process.argv.includes("--version")) { console.log("1.2.3 rehearsal"); process.exit(0); }
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Rehearsal requires a real TTY");
const home = process.env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
if (!home) throw new Error("Missing isolated rehearsal profile");
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log(`Synthetic ${provider} login. This fixture has an extra prompt.`);
  if ((await input.question("Type BLUE to continue this rehearsal: ")).trim() !== "BLUE") process.exitCode = 2;
  else {
    console.log("Preparing a delayed synthetic verification step…");
    await new Promise(resolve => setTimeout(resolve, 700));
    console.log("No browser is needed. Type FINISHED after reading this instruction.");
    if ((await input.question("Confirmation: ")).trim() !== "FINISHED") process.exitCode = 2;
    else {
      let hold = false;
      try { hold = JSON.parse(readFileSync(join(home, "rehearsal.json"), "utf8")).hold === true; } catch {}
      if (hold) await input.question("Synthetic interruption exercise: cancel this login now: ");
      else {
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const jwt = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.synthetic`;
        const value = provider === "codex"
          ? { tokens: { access_token: jwt, refresh_token: "SYNTHETIC-REFRESH", account_id: "synthetic-account" } }
          : { claudeAiOauth: { accessToken: "SYNTHETIC-ACCESS", refreshToken: "SYNTHETIC-REFRESH", expiresAt: exp * 1000, scopes: ["user:inference"] } };
        writeFileSync(join(home, provider === "codex" ? "auth.json" : ".credentials.json"), JSON.stringify(value), { mode: 0o600 });
        console.log("Synthetic login persisted. Verify local status; no provider was contacted.");
      }
    }
  }
} finally { input.close(); }
