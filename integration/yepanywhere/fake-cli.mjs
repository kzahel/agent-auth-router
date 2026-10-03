#!/usr/bin/env node
// Synthetic CLI protocol peer, not a model or an official CLI compatibility test.
import "./offline.mjs";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const provider = process.env.AAR_TEST_PROVIDER;
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log(
    provider === "codex" ? "codex-cli 0.159.0" : "2.1.280 (Claude Code)",
  );
  process.exit(0);
}
if (argv[0] === "auth" || argv[0] === "login") {
  console.log(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    }),
  );
  process.exit(0);
}
const arg = (name) => {
  const equal = argv.find((value) => value.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const config = Object.fromEntries(
  argv.flatMap((value, i) => {
    if (value !== "-c") return [];
    const setting = argv[i + 1];
    const at = setting.indexOf("=");
    return [[setting.slice(0, at), JSON.parse(setting.slice(at + 1))]];
  }),
);
const baseUrl =
  provider === "claude"
    ? process.env.ANTHROPIC_BASE_URL
    : config["model_providers.aar.base_url"];
const token =
  provider === "claude"
    ? process.env.ANTHROPIC_AUTH_TOKEN
    : process.env[config["model_providers.aar.env_key"]];
if (!baseUrl || !/^aar_[A-Za-z0-9_-]{43}$/.test(token ?? ""))
  throw new Error("Native launch lacked its routed transport");
if (new URL(baseUrl).hostname !== "127.0.0.1")
  throw new Error("Non-fixture provider origin");
if (
  provider === "codex" &&
  (config.model_provider !== "aar" ||
    config["model_providers.aar.requires_openai_auth"] !== false)
)
  throw new Error("Codex selected a direct provider");
if (
  provider === "codex" &&
  (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN)
)
  throw new Error("Codex retained ambient direct auth");
if (provider === "claude") {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
    throw new Error("Claude retained ambient direct auth");
  const settings = JSON.parse(arg("--settings"));
  if (
    settings.env?.ANTHROPIC_AUTH_TOKEN !== token ||
    settings.env?.ANTHROPIC_BASE_URL !== baseUrl ||
    settings.apiKeyHelper !== ""
  )
    throw new Error("Claude flag settings did not retain routing precedence");
}
const audit = (event) =>
  appendFileSync(
    join(process.env.HOME, "native.jsonl"),
    JSON.stringify({ provider, ...event }) + "\n",
  );
audit({
  event: "spawn",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  baseUrl,
});
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let sessionId = (provider === "claude" && arg("--resume")) || randomUUID();
let cwd = process.cwd();
let model = provider === "claude" ? arg("--model") : "synthetic-model";
let active;
let initialized = false;
let transcript;
let parentId = null;
function initializeTranscript() {
  if (provider === "claude") {
    const directory = join(
      process.env.CLAUDE_CONFIG_DIR,
      "projects",
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    mkdirSync(directory, { recursive: true });
    transcript = join(directory, `${sessionId}.jsonl`);
  } else {
    const directory = join(
      process.env.CODEX_HOME,
      "sessions",
      "2026",
      "10",
      "03",
    );
    mkdirSync(directory, { recursive: true });
    transcript = join(
      directory,
      `rollout-2026-10-03T00-00-00-${sessionId}.jsonl`,
    );
    appendFileSync(
      transcript,
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: {
          id: sessionId,
          cwd,
          model_provider: "aar",
          originator: "synthetic",
          timestamp: new Date().toISOString(),
        },
      }) + "\n",
    );
  }
}
function persist(role, text) {
  const uuid = randomUUID();
  const row =
    provider === "claude"
      ? {
          type: role,
          uuid,
          parentUuid: parentId,
          sessionId,
          cwd,
          timestamp: new Date().toISOString(),
          message: { role, content: [{ type: "text", text }], model },
        }
      : {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "message",
            id: uuid,
            role,
            content: [
              {
                type: role === "assistant" ? "output_text" : "input_text",
                text,
              },
            ],
          },
        };
  appendFileSync(transcript, JSON.stringify(row) + "\n");
  parentId = uuid;
  return uuid;
}
const textOf = (value) =>
  typeof value === "string"
    ? value
    : (value ?? []).map((item) => item.text ?? "").join("");
async function turn(text, turnId) {
  persist("user", text);
  active = new AbortController();
  let output = "";
  try {
    const response = await fetch(
      `${baseUrl}${provider === "claude" ? "/v1/messages" : "/responses"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: text, stream: true }),
        signal: active.signal,
      },
    );
    audit({ event: "inference", sessionId, status: response.status });
    if (!response.ok)
      throw new Error(`Synthetic provider HTTP ${response.status}`);
    let pending = "";
    for await (const chunk of response.body) {
      pending += Buffer.from(chunk).toString();
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const delta = JSON.parse(event.slice("data: ".length)).text;
        output += delta;
        audit({ event: "delta", sessionId, text: delta });
        if (provider === "codex")
          emit({
            method: "item/agentMessage/delta",
            params: { threadId: sessionId, turnId, itemId: turnId, delta },
          });
        else
          emit({
            type: "stream_event",
            session_id: sessionId,
            uuid: randomUUID(),
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            },
          });
      }
    }
    const uuid = persist("assistant", output);
    if (provider === "codex") {
      emit({
        method: "item/completed",
        params: {
          threadId: sessionId,
          turnId,
          item: { type: "agentMessage", id: turnId, text: output },
        },
      });
      emit({
        method: "turn/completed",
        params: {
          threadId: sessionId,
          turn: { id: turnId, status: "completed", items: [], error: null },
        },
      });
    } else {
      emit({
        type: "assistant",
        uuid,
        session_id: sessionId,
        message: {
          id: uuid,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: output }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      emit({
        type: "result",
        subtype: "success",
        uuid: randomUUID(),
        session_id: sessionId,
        result: output,
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
  } catch (error) {
    if (provider === "codex")
      emit({
        method: "turn/completed",
        params: {
          threadId: sessionId,
          turn: {
            id: turnId,
            status: active.signal.aborted ? "interrupted" : "failed",
            items: [],
            error: { message: error.message },
          },
        },
      });
    else
      emit({
        type: "result",
        subtype: "error_during_execution",
        session_id: sessionId,
        uuid: randomUUID(),
        is_error: true,
        errors: [error.message],
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
  } finally {
    active = undefined;
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (provider === "claude") {
    if (message.type === "control_request") {
      if (message.request.subtype === "interrupt") active?.abort();
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { commands: [], models: [], mcpServers: [] },
        },
      });
    } else if (message.type === "user") {
      if (!initialized) {
        initializeTranscript();
        initialized = true;
        emit({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          uuid: randomUUID(),
          cwd,
          model,
          tools: [],
          mcp_servers: [],
          permissionMode: "default",
          slash_commands: [],
          apiKeySource: "none",
        });
      }
      void turn(textOf(message.message.content), randomUUID());
    }
    return;
  }
  if (message.id === undefined) return;
  const reply = (result) => emit({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({ userAgent: "aar-synthetic-cli" });
      break;
    case "thread/start":
    case "thread/resume":
      sessionId = message.params.threadId ?? sessionId;
      cwd = message.params.cwd ?? cwd;
      model = message.params.model ?? model;
      initializeTranscript();
      audit({ event: message.method, sessionId });
      reply({
        thread: { id: sessionId, cwd, turns: [] },
        model,
        modelProvider: "aar",
        reasoningEffort: "low",
      });
      break;
    case "turn/start": {
      const id = randomUUID();
      reply({ turn: { id, status: "inProgress", items: [], error: null } });
      emit({
        method: "turn/started",
        params: {
          threadId: sessionId,
          turn: { id, status: "inProgress", items: [], error: null },
        },
      });
      void turn(textOf(message.params.input), id);
      break;
    }
    case "turn/interrupt":
      active?.abort();
      reply({});
      break;
    case "thread/goal/get":
      reply({ goal: null });
      break;
    case "model/list":
      reply({ data: [] });
      break;
    case "skills/list":
      reply({ data: [] });
      break;
    case "account/read":
      throw new Error("Routed launch probed the direct account");
    default:
      reply({});
  }
});
lines.on("close", () => {
  active?.abort();
  process.exit(0);
});
