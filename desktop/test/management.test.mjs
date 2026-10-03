import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";

test("management UI preserves typing while observations update, and offers owner actions", async (t) => {
  const server = createServer(async (req, res) => {
    const files = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    const file = files[req.url];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", file[1]);
    res.end(await readFile(resolve(import.meta.dirname, "../ui", file[0])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = {
      routerId: "fixture",
      activeRequests: 0,
      logins: [],
      accounts: Array.from({ length: 48 }, (_, i) => ({
        id: `work-${i + 1}`,
        provider: i < 24 ? "codex" : "claude",
        enabled: true,
        revision: 1,
        freshness: "fresh",
        windows: [
          {
            bucket: "primary",
            usedPercent: 32,
            remainingPercent: 68,
            resetsAt: "2026-10-04T12:00:00Z",
            scope: "all",
          },
        ],
      })),
      pools: [
        {
          id: "work",
          name: "Work Codex",
          provider: "codex",
          policy: "manual",
          revision: 1,
          accountIds: ["work-1", "work-2"],
          bindings: [{ accountId: "work-1", count: 2 }],
        },
      ],
      integrations: [
        {
          id: "ya",
          name: "Yep Anywhere",
          revision: 1,
          revoked: false,
          poolIds: [],
          accountIds: [],
        },
      ],
    };
    window.operations = [];
    window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          window.operations.push({ command, ...args });
          if (command === "startup") return false;
          if (command === "check_update") return { current: true };
          if (args.operation === "overview") {
            await new Promise((r) => setTimeout(r, 150));
            return structuredClone(state);
          }
          if (args.operation === "pools/save") {
            state.pools = [{ ...args.body, revision: args.body.revision + 1, bindings: [] }];
          }
          if (args.operation === "grants/save") Object.assign(state.integrations[0], args.body);
          return {};
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "Edit pool", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Pool name" });
  await input.clear();
  await input.evaluate((field) => {
    window.samples = [];
    field.addEventListener("input", () => {
      const start = performance.now(),
        value = field.value;
      requestAnimationFrame(() =>
        window.samples.push({
          elapsed: performance.now() - start,
          retained: field.value.startsWith(value),
        }),
      );
    });
  });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const name = "Work Codex shared development pool";
  await input.pressSequentially(name, { delay: 20 });
  assert.equal(await input.inputValue(), name);
  await page.waitForTimeout(30);
  const samples = await page.evaluate(() => window.samples);
  assert.equal(samples.length, name.length);
  assert.ok(
    samples.every((s) => s.retained && s.elapsed < 100),
    JSON.stringify(samples),
  );
  await page.getByRole("button", { name: "Save pool", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await page.locator("#grant-pools input").check();
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.operations)).some(
      (o) => o.operation === "grants/save" && o.body.poolIds.includes("work"),
    ),
  );
  await page.getByText("1 pool grants · 0 direct account grants", { exact: true }).waitFor();
  // Present a compact account slice for visual inspection while preserving the volume test above.
  await page.evaluate(() =>
    [...document.querySelectorAll("#accounts article")].slice(4).forEach((el) => el.remove()),
  );
  const captures = process.env.AAR_UI_CAPTURE_DIR;
  if (captures) {
    await mkdir(captures, { recursive: true });
    for (const size of [
      { width: 1000, height: 900 },
      { width: 520, height: 900 },
    ]) {
      await page.setViewportSize(size);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(captures, `desktop-${size.width}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  t.diagnostic(
    `${samples.length} sequential keystrokes; maximum ${Math.max(...samples.map((s) => s.elapsed)).toFixed(1)} ms`,
  );
});
