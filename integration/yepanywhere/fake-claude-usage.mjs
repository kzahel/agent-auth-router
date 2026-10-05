// Synthetic Claude CLI stream-json control boundary for usage reads. No
// prompt, model session or inference. Like the CLI, it reads usage with the
// profile's stored access token, here from the loopback upstream fixture.
import "./offline.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const origin = process.argv[2];
const reply = (request_id, response) =>
  process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response } })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type !== "control_request") throw new Error("Unexpected Claude CLI input");
  const subtype = message.request.subtype;
  if (subtype === "initialize") {
    reply(message.request_id, { models: [], account: { subscriptionType: "Claude Max", apiProvider: "firstParty" } });
  } else if (subtype === "get_usage") {
    const { accessToken } = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")).claudeAiOauth;
    const response = await fetch(`${origin}/api/oauth/usage`, { headers: { authorization: `Bearer ${accessToken}` } });
    reply(message.request_id, { rate_limits_available: true, rate_limits: await response.json() });
  } else throw new Error("Unexpected Claude control request");
}
