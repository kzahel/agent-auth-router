import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "@playwright/test";

test("embedded terminal supports keyboard input, resize, theme, cancellation and local-only output", async t => {
  const root = resolve(import.meta.dirname, "../ui");
  const config = JSON.parse(await readFile(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json")));
  const server = createServer(async (req, res) => {
    const path = req.url === "/" ? "/terminal.html" : req.url;
    if (!/^\/(terminal\.(html|js|css)|style\.css|vendor\/(xterm\.(js|css)|addon-fit\.js))$/.test(path)) return res.writeHead(404).end();
    res.setHeader("Content-Security-Policy", config.app.security.csp);
    res.setHeader("content-type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(path)]);
    res.end(await readFile(join(root, path)));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 740, height: 480 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    window.operations = []; window.queue = ["\x1b[32mOfficial CLI fixture\x1b[0m\r\n1. Browser sign-in\r\n2. Device code\r\nChoose [1/2]: "]; window.input = ""; window.running = true;
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        window.operations.push({ command, ...args });
        if (args.action === "start") return { provider: "codex", home: "/Users/example/.codex" };
        if (args.action === "write") { window.input += args.data; window.queue.push(args.data.replace(/\r/g, "\r\n")); }
        if (args.action === "cancel") window.running = false;
        if (args.action === "read") return { bytes: Array.from(new TextEncoder().encode(window.queue.splice(0).join(""))), running: window.running, status: window.running ? "running" : "cancelled", pending: false };
        return {};
      } },
      window: { getCurrentWindow: () => ({ close: async () => { window.closedByUser = true; } }) },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("heading", { name: "codex sign-in" }).waitFor();
  await page.getByText("/Users/example/.codex", { exact: true }).waitFor();
  await page.locator(".xterm-helper-textarea").pressSequentially("2", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.input === "2\r");
  await page.evaluate(() => window.queue.push('\x1b]52;c;ZXhmaWx0cmF0ZQ==\x07\r\n<img src=x onerror="window.injected=true">\r\nPaste your confirmation: '));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("#terminal img").count(), 0);
  const captures = process.env.AAR_UI_CAPTURE_DIR;
  if (captures) await mkdir(captures, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [740, 520]) {
      await page.setViewportSize({ width, height: 480 });
      await page.waitForTimeout(150);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok((await page.evaluate(() => window.operations)).some(o => o.action === "resize" && o.cols >= 20));
      if (captures) await page.screenshot({ path: join(captures, `terminal-${scheme}-${width}.png`) });
    }
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("cancelled", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.evaluate(() => window.closedByUser), true);
  assert.ok((await page.evaluate(() => window.operations)).every(o => o.command === "terminal"));
  assert.deepEqual(errors, []);
});
