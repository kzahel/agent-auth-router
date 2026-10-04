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
        home: `/Users/example/.agent-auth-router/profiles/work-${i + 1}`,
        nickname: null,
        provider: i < 24 ? "codex" : "claude",
        enabled: true,
        revision: 1,
        freshness: "fresh",
        windows: [
          {
            bucket: "primary",
            usedPercent: 32,
            remainingPercent: i === 1 ? 0 : i === 2 ? 100 : i === 3 ? null : 68,
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
    window.fixtureState = state;
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
          if (args.operation === "profiles/discover") return { profiles: [{ home: "/Users/example/.codex", enrolled: false }] };
          if (args.operation === "profiles/inspect") return { credentialStore: "file", credentialStatus: "ok", canEnroll: true, detail: "Stored credentials readable; provider access is not checked" };
          if (args.operation === "accounts/removal-preview") {
            const a = state.accounts.find(a => a.id === args.body.id);
            return { id: a.id, revision: a.revision, home: a.home, canDeleteProfile: !a.imported,
              deleteIdentity: a.imported ? null : "1:fixture", reason: a.imported ? "Imported profiles are kept." : "Permanently deletes this folder and everything inside it. Keychain credentials are not deleted." };
          }
          if (args.operation === "accounts/remove") {
            if (window.removalFailure) throw Error("Router busy; finish sign-ins before removing it.");
            state.accounts = state.accounts.filter(a => a.id !== args.body.id);
            for (const p of state.pools) p.accountIds = p.accountIds.filter(id => id !== args.body.id);
          }
          if (args.operation === "accounts/set-nickname") {
            Object.assign(state.accounts.find(a => a.id === args.body.id), { nickname: args.body.nickname, revision: args.body.revision + 1 });
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
  await page.getByRole("tab", { name: "Pools", exact: true }).click();
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
  await page.locator("#pool-form select[name=policy]").selectOption("most-remaining");
  await page.getByRole("button", { name: "Save pool", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.getByText("codex · Most remaining · 2 accounts", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureState.pools[0].policy), "most-remaining");
  await page.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await page.locator("#grant-pools input").check();
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.operations)).some(
      (o) => o.operation === "grants/save" && o.body.poolIds.includes("work"),
    ),
  );
  await page.getByText("1 pool grants · 0 direct account grants", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  const account = page.locator("#accounts article").first();
  assert.equal(await account.getByRole("heading").textContent(), "/Users/example/.agent-auth-router/profiles/work-1");
  assert.equal(await account.getByRole("progressbar").getAttribute("value"), "68");
  await account.getByText("primary · 68% left", { exact: true }).waitFor();
  assert.equal(await page.locator("#accounts article").nth(1).getByRole("progressbar").getAttribute("value"), "0");
  assert.equal(await page.locator("#accounts article").nth(2).getByRole("progressbar").getAttribute("value"), "100");
  assert.equal(await page.locator("#accounts article").nth(3).getByRole("progressbar").getAttribute("value"), null);
  await account.getByText("More", { exact: true }).click();
  await account.getByRole("button", { name: "Edit nickname" }).click();
  const nickname = page.locator("#nickname-form input[name=nickname]");
  await nickname.fill("Work account");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  assert.equal(await nickname.inputValue(), "Work account");
  await page.getByRole("button", { name: "Save nickname" }).click();
  await account.getByText("Work account", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "App", exact: true }).click();
  await page.locator("#terminal-presentation").selectOption("embedded");
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  assert.ok((await page.evaluate(() => window.operations)).some(o => o.operation === "accounts/terminal-login" && o.body.id === "work-1" && o.body.presentation === "embedded"));
  assert.ok(!(await page.evaluate(() => window.operations)).some(o => o.operation === "accounts/login"));
  await account.getByText("More", { exact: true }).click();
  await account.getByRole("button", { name: "Edit nickname" }).click();
  await nickname.fill("");
  await page.getByRole("button", { name: "Save nickname" }).click();
  await page.waitForFunction(() => !document.querySelector("#accounts .nickname"));
  await page.getByText("Add account", { exact: true }).first().click();
  await page.locator("#account-form button[type=submit]").click();
  const enrollment = (await page.evaluate(() => window.operations)).find(o => o.operation === "accounts/add");
  assert.deepEqual(enrollment.body, { nickname: "", provider: "codex" });
  await page.locator("#account-form select[name=enrollment]").selectOption("existing");
  assert.equal(await page.locator("#account-form button[type=submit]").isDisabled(), true);
  await page.getByRole("button", { name: "Find profiles" }).click();
  await page.getByRole("button", { name: "/Users/example/.codex", exact: true }).click();
  await page.getByRole("button", { name: "Check profile", exact: true }).click();
  await page.getByText("file · ok · Stored credentials readable; provider access is not checked", { exact: true }).waitFor();
  await page.locator("#account-form input[name=home]").fill("/Users/example/other");
  assert.equal(await page.locator("#account-form button[type=submit]").isDisabled(), true, "editing profile invalidates inspection");
  await page.getByRole("button", { name: "Check profile", exact: true }).click();
  await page.locator("#account-form button[type=submit]").click();
  const reuse = (await page.evaluate(() => window.operations)).filter(o => o.operation === "accounts/add").at(-1);
  assert.deepEqual(reuse.body, { nickname: "", provider: "codex", enrollment: "existing", home: "/Users/example/other", credentialStore: "file" });
  await page.getByText("Add account", { exact: true }).first().click();
  // Present a compact account slice for visual inspection while preserving the volume test above.
  await page.evaluate(() => { window.fixtureState.accounts = window.fixtureState.accounts.slice(0, 4); });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#accounts article").length === 4);
  await page.getByRole("tab", { name: "Accounts", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "Pools", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("Home");
  assert.equal(await page.getByRole("tab", { name: "Accounts", exact: true }).getAttribute("aria-selected"), "true");
  const captures = process.env.AAR_UI_CAPTURE_DIR;
  if (captures) await mkdir(captures, { recursive: true });
  const colors = [];
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    colors.push(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor));
    for (const size of [{ width: 680, height: 640 }, { width: 520, height: 900 }]) {
      await page.setViewportSize(size);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok((await account.boundingBox()).height < 155, "account rows should stay compact");
      if (captures) {
        await page.screenshot({ path: join(captures, `desktop-${scheme}-${size.width}.png`), fullPage: true });
        await page.getByRole("tab", { name: "Pools", exact: true }).click();
        await page.getByRole("button", { name: "Edit pool", exact: true }).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(captures, `pool-editor-${scheme}-${size.width}.png`), fullPage: true });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByRole("tab", { name: "Accounts", exact: true }).click();
      }
    }
  }
  assert.notEqual(colors[0], colors[1], "palette follows system color scheme without reload");
  // Confirmation defaults to preserving files; cancellation and Escape do not mutate.
  assert.equal(await page.getByRole("button", { name: "Retire", exact: true }).count(), 0);
  await account.getByText("More", { exact: true }).click();
  await account.getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remove account?", exact: true });
  const deletion = dialog.getByRole("checkbox", { name: "Also delete the profile folder" });
  assert.equal(await deletion.isChecked(), false);
  assert.equal(await page.locator(":focus").textContent(), "Cancel");
  await deletion.check();
  if (captures) await page.screenshot({ path: join(captures, "remove-dialog-dark.png") });
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), false);
  assert.equal((await page.evaluate(() => window.operations)).filter(o => o.operation === "accounts/remove").length, 0);
  await account.getByRole("button", { name: "Remove", exact: true }).click();
  assert.equal(await deletion.isChecked(), false, "reopening never preserves deletion consent");
  await page.evaluate(() => { window.removalFailure = true; });
  await dialog.getByRole("button", { name: "Remove account", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "Router busy" }).waitFor();
  assert.equal(await page.locator("#accounts article").count(), 4);
  await page.evaluate(() => { window.removalFailure = false; });
  await dialog.getByRole("button", { name: "Remove account", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#accounts article").length === 3);
  const keep = (await page.evaluate(() => window.operations)).filter(o => o.operation === "accounts/remove").at(-1);
  assert.equal(keep.body.deleteProfile, false);
  assert.equal(keep.body.home, undefined);
  // The same action is available for legacy retired rows.
  await page.evaluate(() => { window.fixtureState.accounts[0].retired = true; });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await account.getByText("Retired · credential profile retained", { exact: true }).waitFor();
  await account.getByRole("button", { name: "Remove", exact: true }).click();
  await deletion.check();
  await dialog.getByRole("button", { name: "Remove & delete folder", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#accounts article").length === 2);
  const destroy = (await page.evaluate(() => window.operations)).filter(o => o.operation === "accounts/remove").at(-1);
  assert.equal(destroy.body.deleteProfile, true);
  assert.equal(destroy.body.home, "/Users/example/.agent-auth-router/profiles/work-2");
  assert.equal(destroy.body.deleteIdentity, "1:fixture");
  await page.evaluate(() => { window.fixtureState.accounts[0].imported = true; });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await account.getByText("More", { exact: true }).click();
  await account.getByRole("button", { name: "Remove", exact: true }).click();
  assert.equal(await deletion.isChecked(), false);
  assert.equal(await deletion.isDisabled(), true);
  await dialog.getByText("Imported profiles are kept.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(errors, []);
  t.diagnostic(
    `${samples.length} sequential keystrokes; maximum ${Math.max(...samples.map((s) => s.elapsed)).toFixed(1)} ms`,
  );
});
