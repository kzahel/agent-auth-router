// End to end: `aar serve` with its web dashboard, synthetic accounts and a
// mock upstream. A browser signs in with the printed link, watches streamed
// requests arrive live, and the link cannot be reused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "src/cli.ts");

/** Claude-shaped SSE: usage at message_start and message_delta, text deltas between. */
function claudeStream(res, { deltas = 12, delayMs = 60 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600) });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_1", model: "claude-synthetic-1", usage: { input_tokens: 120, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 1 } } });
  let i = 0;
  const timer = setInterval(() => {
    if (i++ < deltas) { send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "synthetic output ".repeat(4) } }); return; }
    clearInterval(timer);
    send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 211 } });
    send("message_stop", {});
    res.end();
  }, delayMs);
}

test("web dashboard signs in once, shows live traffic and keeps the access link single-use", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "aar-web-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/messages") claudeStream(res);
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, upstreams: { claude: upstreamOrigin, codex: upstreamOrigin } }));
  const aar = (...args) => execFileSync(process.execPath, [cli, "--state", state, ...args], { encoding: "utf8" });
  const home = join(state, "profiles", "work");
  aar("account", "add", "work", "--provider", "claude", "--home", home, "--credential-store", "file", "--helper", "none");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC-ACCESS", refreshToken: "SYNTHETIC-REFRESH", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
  const token = aar("client", "add", "laptop", "--claude", "work").match(/aar_[A-Za-z0-9_-]+/)[0];

  const router = spawn(process.execPath, [cli, "--state", state, "serve"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => router.kill("SIGTERM"));
  let stdout = "", stderr = "";
  router.stdout.on("data", (c) => { stdout += c; });
  router.stderr.on("data", (c) => { stderr += c; });
  for (let i = 0; i < 100 && !/Web dashboard: (\S+)/.test(stdout); i++) await new Promise((r) => setTimeout(r, 50));
  const link = stdout.match(/Web dashboard: (\S+)/)?.[1];
  assert.ok(link, `dashboard link printed: ${stdout} ${stderr}`);
  const origin = JSON.parse(stderr.split("\n").find((l) => l.includes("router.listening"))).origin;

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(link);
  await page.getByRole("tab", { name: "Dashboard", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "the access code leaves the address bar");
  await page.getByText("Router running", { exact: false }).waitFor();
  // Desktop-only controls are hidden in the browser.
  await page.getByRole("tab", { name: "App", exact: true }).click();
  assert.equal(await page.getByText("Launch at login").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Check for updates" }).isVisible(), false);
  await page.getByRole("tab", { name: "Dashboard", exact: true }).click();

  const stream = () => fetch(`${origin}/claude/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-synthetic-1", stream: true, messages: [] }) }).then((r) => r.text());
  const first = stream();
  await page.locator("#dash-requests").getByText("streaming", { exact: true }).waitFor();
  const relayed = await first;
  assert.match(relayed, /"output_tokens":211/, "the relayed stream is unchanged");
  await Promise.all([stream(), stream()]);
  const rows = page.locator("#dash-requests tbody tr");
  await page.waitForFunction(() => document.querySelectorAll("#dash-requests tbody tr").length === 3 && ![...document.querySelectorAll("#dash-requests tbody tr")].some((r) => r.textContent.includes("streaming")));
  const row = await rows.first().textContent();
  assert.match(row, /laptop → work/);
  assert.match(row, /claude-synthetic-1/);
  assert.match(row, /9\.4k \(96% cached\)/);
  assert.match(row, /211/, "the provider figure replaces the live estimate");
  assert.doesNotMatch(row, /~/);
  assert.equal(await page.locator("#dash-accounts tbody tr").count(), 1);
  // Totals for the visible range come from completed buckets.
  await page.waitForFunction(() => document.querySelector("#dash-summary tbody")?.textContent.includes("633"), null, { timeout: 8000 });
  const summary = await page.locator("#dash-summary").textContent();
  assert.match(summary, /Output.*633/s, "three responses × 211 output tokens");
  assert.match(summary, /Cache read.*27k/s);
  const snapshot = await (await fetch(`${new URL(link).origin}/v1/app/metrics/snapshot`, { method: "POST", headers: { authorization: `Bearer ${(await import("node:fs")).readFileSync(join(state, "owner.key"), "utf8")}`, "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(snapshot.result.scopes["account:work"].minute.output, 633);
  // Scoping to the account adds its quota history from the rate-limit headers.
  await page.locator("#dash-scope").selectOption("account:work");
  await page.locator("#dash-quota canvas").waitFor();
  await page.waitForFunction(() => document.querySelector("#dash-quota-empty")?.hidden === true);
  await page.locator("#dash-graph").hover({ position: { x: 600, y: 60 } });

  const captures = process.env.AAR_UI_CAPTURE_DIR;
  if (captures) {
    await mkdir(captures, { recursive: true });
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(captures, `web-dashboard-${scheme}.png`), fullPage: true });
    }
  }

  // A browser cannot open a terminal on the router's machine: Sign in shows the official command.
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.locator("#accounts article").first().getByRole("button", { name: "Sign in", exact: true }).click();
  const command = await page.locator(".login-command pre").textContent();
  assert.match(command, /CLAUDE_CONFIG_DIR=.*profiles\/work.* claude auth login --claudeai/);
  await page.getByRole("tab", { name: "Dashboard", exact: true }).click();

  // The link was single-use: a second browser stays signed out.
  const other = await browser.newPage();
  await other.goto(link);
  await other.getByText("Access link expired or already used", { exact: false }).waitFor();
  assert.equal(await other.locator("#app-shell").isVisible(), false);
  // Logging out ends the session on the server.
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to the dashboard" }).waitFor();
  assert.deepEqual(errors, []);
});
