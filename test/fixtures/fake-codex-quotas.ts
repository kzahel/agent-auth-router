import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODEX_HOME!;
const mode = process.argv[2] ?? "ok";
writeFileSync(join(home, "process.json"), JSON.stringify({ cwd: process.cwd(), home,
  base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY,
  claude: process.env.CLAUDE_CONFIG_DIR, token: process.env.ANTHROPIC_AUTH_TOKEN }));
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(join(home, "requests.jsonl"), line + "\n");
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "account/rateLimits/read") {
    if (mode === "hang") return;
    if (mode === "oversized") { process.stdout.write("x".repeat(300 * 1024)); return; }
    if (mode === "malformed") { process.stdout.write("SECRET-invalid-json\n"); return; }
    if (mode === "error") { process.stderr.write("SECRET-stderr"); send({ id: request.id, error: { message: "SECRET-provider-error" } }); return; }
    if (mode === "server-request") { send({ id: "server", method: "account/chatgptAuthTokens/refresh", params: { token: "SECRET-server" } }); return; }
    send({ id: request.id, result: { email: "SECRET-email", token: "SECRET-token", rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791000000 },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } },
      codex_other: { primary: { usedPercent: 101, windowDurationMins: null, resetsAt: null } },
    } } });
  }
  if (request.id === "server" && request.error?.code === -32601) send({ id: 2, result: { rateLimits: {
    limitId: "codex", primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null },
  } } });
});
rl.on("close", () => { if (mode === "hang") setInterval(() => {}, 1000); });
