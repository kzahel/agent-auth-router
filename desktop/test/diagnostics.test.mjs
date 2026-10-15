// Real browser -> authenticated app protocol -> shared doctor, with synthetic
// accounts and official-CLI stand-ins. No provider credentials or inference.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../.."), cli = join(root, "src/cli.ts");
test("web diagnostics keep typing responsive, scope credential checks and render on phone and desktop", async t => {
  const state = mkdtempSync(join(tmpdir(), "aar-doctor-web-"));
  const bin = join(state, "bin"); mkdirSync(bin, { mode: 0o700 });
  for (const provider of ["claude", "codex"]) writeFileSync(join(bin, provider), `#!/usr/bin/env node
if(process.argv[2] !== '--version') process.exit(2);
setTimeout(()=>console.log('1.2.3'), 250);
`, { mode: 0o700 });
  writeFileSync(join(state, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  execFileSync(process.execPath, [cli, "--state", state, "account", "add", "work", "--provider", "codex", "--helper", "none"], { stdio: "pipe" });
  const router = spawn(process.execPath, [cli, "--state", state, "serve", "--no-event-log"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (router.exitCode === null) { const closed = new Promise(r => router.once("close", r)); router.kill("SIGTERM"); await closed; }
    rmSync(state, { recursive: true, force: true });
  });
  let output = "", errors = "";
  router.stdout.on("data", c => { output += c; }); router.stderr.on("data", c => { errors += c; });
  for (let i = 0; i < 100 && !/Web dashboard: (\S+)/.test(output); i++) await new Promise(r => setTimeout(r, 50));
  const link = output.match(/Web dashboard: (\S+)/)?.[1]; assert.ok(link, errors);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const pageErrors = []; page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto(link);
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Check sign-in", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Run diagnostics", exact: true }).click();
  const filter = page.getByRole("searchbox", { name: "Filter diagnostics" });
  await filter.evaluate(field => {
    window.samples = [];
    field.addEventListener("input", () => {
      const at = performance.now(), value = field.value;
      requestAnimationFrame(() => window.samples.push({ elapsed: performance.now() - at, retained: field.value.startsWith(value) }));
    });
  });
  const query = "credential store was not read";
  await filter.pressSequentially(query, { delay: 20 });
  await page.getByText("Credential store was not read.", { exact: false }).waitFor();
  assert.equal(await filter.inputValue(), query);
  const samples = await page.evaluate(() => window.samples);
  assert.equal(samples.length, query.length);
  assert.ok(samples.every(s => s.retained && s.elapsed < 100), JSON.stringify(samples));
  await filter.clear();
  await page.getByRole("combobox", { name: "Diagnostic account" }).selectOption("work");
  await page.getByRole("button", { name: "Check sign-in", exact: true }).click();
  await page.getByText("No saved login was found.", { exact: true }).waitFor();
  // The copy operation must use the sanitized server projection, not rendered
  // local account labels. Stub clipboard delivery, not report generation.
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedReport = text; } } }); });
  await page.getByRole("button", { name: "Copy report", exact: true }).click();
  await page.getByText("Copied sanitized report.", { exact: true }).waitFor();
  const copied = await page.evaluate(() => window.copiedReport);
  assert.match(copied, /login-signed_out/); assert.doesNotMatch(copied, /account:work|profiles\/|aar_owner_|tokenSha256/);
  await page.getByRole("button", { name: "Run diagnostics", exact: true }).click();
  await page.getByText("Credential store was not read.", { exact: false }).waitFor();
  if (process.env.AAR_DIAGNOSTICS_CAPTURE_DIR) {
    await page.screenshot({ path: join(process.env.AAR_DIAGNOSTICS_CAPTURE_DIR, "diagnostics-desktop.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone has no horizontal overflow");
  if (process.env.AAR_DIAGNOSTICS_CAPTURE_DIR) {
    await page.screenshot({ path: join(process.env.AAR_DIAGNOSTICS_CAPTURE_DIR, "diagnostics-phone.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Open Accounts", exact: true }).first().click();
  assert.equal(await page.getByRole("tab", { name: "Accounts", exact: true }).getAttribute("aria-selected"), "true");
  assert.deepEqual(pageErrors, []);
  console.log(`${samples.length} diagnostic filter keys retained; maximum ${Math.max(...samples.map(s => s.elapsed)).toFixed(1)} ms`);
});
