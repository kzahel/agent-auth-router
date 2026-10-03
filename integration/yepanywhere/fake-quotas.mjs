// Synthetic official app-server quota boundary. No model session or inference.
import "./offline.mjs";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialized") continue;
  if (request.method !== "initialize" && request.method !== "account/rateLimits/read") throw new Error("Unexpected quota RPC");
  const path = join(process.env.CODEX_HOME, "quota-used.json");
  const usedPercent = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : 25;
  const result = request.method === "initialize" ? {} : { rateLimits: { limitId: "codex", primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } };
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
