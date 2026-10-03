// Stand-in for `codex app-server` over stdio. Usage: node fake-codex-app-server.ts <mode>
// Modes: renew | unchanged | logged-out | refresh-failed | hang | server-request
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "renew";
const home: string =
  process.env.CODEX_HOME ??
  (process.stderr.write("CODEX_HOME missing\n"), process.exit(3));
const record = (entry: unknown) => appendFileSync(join(home, "rpc-log.jsonl"), JSON.stringify(entry) + "\n");
record({ env: Object.keys(process.env).sort(), cwd: process.cwd() });

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message: { id?: number; method?: string; params?: { refreshToken?: boolean }; error?: unknown }) {
  record({ id: message.id, method: message.method, params: message.params, error: message.error !== undefined });
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex/0.0.0" } });
    return;
  }
  if (message.method !== "account/read") return;
  if (mode === "hang") return;
  if (mode === "logged-out" || (mode === "refresh-failed" && message.params?.refreshToken)) {
    send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    return;
  }
  if (mode === "server-request") send({ id: 900, method: "item/commandExecution/requestApproval", params: {} });
  if (mode !== "unchanged" && message.params?.refreshToken) {
    const access = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, nonce: "renewed" })}.c2ln`;
    const auth = {
      OPENAI_API_KEY: null,
      tokens: { id_token: "synthetic-id", access_token: access, refresh_token: "SECRET-REFRESH-renewed", account_id: "acct-synthetic" },
      last_refresh: new Date().toISOString(),
    };
    writeFileSync(join(home, "auth.json.tmp"), JSON.stringify(auth));
    renameSync(join(home, "auth.json.tmp"), join(home, "auth.json"));
  }
  send({ id: message.id, result: { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true } });
}
