// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Usage: node fake-claude-cli.ts <mode>
// Modes: ok | renew | logged-out | no-usage | reject-usage | hang | oversized | callback | slow | api-key | odd-models
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";
const home: string =
  process.env.CLAUDE_CONFIG_DIR ??
  (process.stderr.write("CLAUDE_CONFIG_DIR missing\n"), process.exit(3));
const record = (entry: unknown) => appendFileSync(join(home, "cli-log.jsonl"), JSON.stringify(entry) + "\n");
record({ event: "start", pid: process.pid, at: Date.now(), argv: process.argv.slice(3), cwd: process.cwd(), env: Object.keys(process.env).sort() });
process.on("exit", () => record({ event: "exit", pid: process.pid, at: Date.now() }));
process.stderr.write("SECRET-stderr access_token=SECRET-LEAK\n");

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id: string, response: unknown) => send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function renewIfExpired(): void {
  const path = join(home, ".credentials.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as { claudeAiOauth: { expiresAt: number; refreshToken?: string } };
  if (stored.claudeAiOauth.expiresAt > Date.now() || !stored.claudeAiOauth.refreshToken) return;
  const renewed = { claudeAiOauth: { accessToken: `renewed-${Date.now()}`, refreshToken: "SECRET-REFRESH-renewed", expiresAt: Date.now() + 3600_000 } };
  writeFileSync(`${path}.tmp`, JSON.stringify(renewed));
  renameSync(`${path}.tmp`, path);
}

// Shaped like Claude Code's initialize.models rows; names and ids are synthetic.
const MODELS = [
  { value: "default", resolvedModel: "claude-opus-fixture-2", displayName: "Default (recommended)", description: "Opus Fixture 2 for complex work", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-fixture-2", displayName: "Sonnet", description: "Sonnet Fixture 2 for everyday tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true },
  { value: "haiku", resolvedModel: "claude-haiku-fixture-1", displayName: "Haiku", description: "Haiku Fixture 1 for quick answers", supportsEffort: false },
  { value: "opusplan", displayName: "Opus Plan Mode", description: "Opus in plan mode, Sonnet otherwise" },
];
const ODD_MODELS = [
  ...Array.from({ length: 70 }, (_, i) => ({ value: `m${i}`, displayName: "N".repeat(500), description: "D".repeat(1000), supportedEffortLevels: ["high", "SECRET-level", 7], secret: "SECRET-extra" })),
];
ODD_MODELS.splice(0, 3, null as never, { displayName: "no value" } as never, { value: "x".repeat(300), displayName: "too long" } as never);

let callbackAnswered = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype: string }; response?: { subtype: string; request_id: string } };
  record({ event: "message", type: message.type, subtype: message.request?.subtype ?? message.response?.subtype });
  if (message.type === "control_response" && message.response?.request_id === "cli-callback") {
    callbackAnswered = message.response.subtype === "error";
    return;
  }
  if (message.type !== "control_request" || !message.request_id) return;
  const id = message.request_id;
  if (message.request?.subtype === "initialize") {
    if (mode === "callback") send({ type: "control_request", request_id: "cli-callback", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    const account = mode === "logged-out" ? { tokenSource: "none", apiProvider: "firstParty" }
      : mode === "api-key" ? { apiProvider: "bedrock" }
      : { email: "SECRET-email", organization: "SECRET-org", subscriptionType: "Claude Max", apiProvider: "firstParty" };
    reply(id, { models: mode === "odd-models" ? ODD_MODELS : MODELS, account, pid: process.pid });
    return;
  }
  if (message.request?.subtype === "get_usage") {
    if (mode === "hang") return;
    if (mode === "oversized") { process.stdout.write("x".repeat(2 * 1024 * 1024)); return; }
    if (mode === "reject-usage") { send({ type: "control_response", response: { subtype: "error", request_id: id, error: "SECRET-provider-error" } }); return; }
    if (mode === "slow") await sleep(300);
    if (mode === "callback" && !callbackAnswered) { send({ type: "control_response", response: { subtype: "error", request_id: id, error: "callback unanswered" } }); return; }
    if (mode === "renew" || mode === "slow") renewIfExpired();
    if (mode === "no-usage") { reply(id, { subscription_type: null, rate_limits_available: false, rate_limits: null }); return; }
    reply(id, {
      session: { total_cost_usd: 0 }, subscription_type: "max", rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3600_000).toISOString().replace("Z", "+00:00"), locked_reason: null },
        seven_day: { utilization: 45, resets_at: new Date(Date.now() + 86400_000).toISOString().replace("Z", "+00:00") },
        seven_day_opus: null, codename_bucket: null,
        extra_usage: { is_enabled: false, utilization: null },
      },
      token: "SECRET-token",
    });
  }
});
rl.on("close", () => { if (mode === "hang") setInterval(() => {}, 1000); else process.exit(0); });
