#!/usr/bin/env node
// Synthetic `agy acp` peer: ACP over stdio and Cloud Code calls to the endpoint
// it was launched with. Not a model or an official CLI compatibility test.
import "./offline.mjs";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("1.5.15");
  process.exit(0);
}
const option = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const endpoint = option("--cloud_code_endpoint");
const profile = option("--gemini-dir");
if (argv[0] !== "acp" || !endpoint || !profile)
  throw new Error("Native launch lacked its routed transport");
if (new URL(endpoint).hostname !== "127.0.0.1")
  throw new Error("Non-fixture provider origin");
// agy presents the login in its profile. A routed profile holds no Google login.
const loginFile = readFileSync(
  join(profile, "antigravity-cli", "antigravity-oauth-token"),
  "utf8",
);
const login = JSON.parse(loginFile).token.access_token;
// Hashes of everything this process was given that is shaped like an AAR
// token, so a test can show which tokens it never received.
const heldTokenHashes = [...argv, ...Object.values(process.env), loginFile]
  .flatMap((value) => [...value.matchAll(/(?=(aar_[A-Za-z0-9_-]{43}))/g)])
  .map((match) => createHash("sha256").update(match[1]).digest("hex"));
const audit = (event) =>
  appendFileSync(
    join(process.env.HOME, "native.jsonl"),
    JSON.stringify({ provider: "antigravity", ...event }) + "\n",
  );
audit({ event: "spawn", pid: process.pid, endpoint, heldTokenHashes });
const sessionId = randomUUID();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "synthetic-model",
    options: [{ value: "synthetic-model", name: "Synthetic" }],
  },
];
async function prompt(id, text) {
  const response = await fetch(
    `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${login}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "synthetic-model", input: text }),
    },
  );
  const body = await response.text();
  const answer = response.ok
    ? JSON.parse(body.slice("data: ".length)).text
    : undefined;
  if (response.ok)
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answer },
        },
      },
    });
  reply(id, { stopReason: response.ok ? "end_turn" : "refusal" });
  audit({
    event: "turn",
    pid: process.pid,
    status: response.status,
    text: answer,
  });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: 1,
        agentInfo: { version: "1.5.15" },
      });
      break;
    case "session/new": {
      const conversations = join(profile, "antigravity-cli", "conversations");
      mkdirSync(conversations, { recursive: true });
      writeFileSync(join(conversations, `${sessionId}.db`), "synthetic");
      reply(message.id, {
        sessionId,
        models: {
          currentModelId: "synthetic-model",
          availableModels: [{ modelId: "synthetic-model", name: "Synthetic" }],
        },
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        configOptions,
      });
      break;
    }
    case "session/prompt":
      void prompt(
        message.id,
        message.params.prompt.map((part) => part.text ?? "").join(""),
      );
      break;
    case "session/set_config_option":
      reply(message.id, { configOptions });
      break;
    default:
      reply(message.id, {});
  }
});
