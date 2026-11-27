import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { App } from "./App.tsx";

const snapshots = {
  live: () => ({ at: Date.now(), scopes: {} }),
  requests: () => ({ requests: [] }),
  activity: () => ({ accounts: {} }),
};

describe("dashboard access", () => {
  it("shows the login command when the whole dashboard requires sign-in", async () => {
    const app = await fakeApp();
    const callsBeforeRender = app.calls.length;
    app.render(<App signedOut="This browser is not signed in." loginCommand="aar --state '/server/state' dashboard url" />);
    expect(screen.getByRole("heading", { name: "Sign in to the dashboard" })).toBeTruthy();
    expect(screen.getByText("aar --state '/server/state' dashboard url")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(app.calls).toHaveLength(callsBeforeRender);
  });

  it("lets viewers use the dashboard and gates every management tab without mounting its controls", async () => {
    const app = await fakeApp({ overview: () => overview({ accounts: [account("work")] }) }, { access: "viewer", snapshots });
    await app.router.reload();
    app.render(<App loginCommand="aar --state '/server/state' dashboard url" />);
    expect(screen.getByText(/View only/)).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    for (const name of ["Accounts", "Resets", "Pools", "Connections", "Settings"]) {
      await userEvent.click(screen.getByRole("tab", { name }));
      const panel = within(screen.getByRole("tabpanel"));
      expect(panel.getByRole("heading", { name: "Sign in to manage the router" })).toBeTruthy();
      expect(panel.getByText("aar --state '/server/state' dashboard url")).toBeTruthy();
      expect(panel.getAllByRole("button")).toEqual([panel.getByRole("button", { name: "Copy command" })]);
    }
    expect(app.calls.every(c => ["overview", "sessions/recent", "history/cost"].includes(c.operation))).toBe(true);
    await userEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  for (const desktop of [false, true]) {
    it(`${desktop ? "Tauri" : "signed-in web"} owners can open management tabs`, async () => {
      const app = await fakeApp({}, { ...(desktop ? { native: {} } : {}), snapshots });
      await app.router.reload();
      app.render(<App />);
      expect(screen.queryByText(/View only/)).toBeNull();
      await userEvent.click(screen.getByRole("tab", { name: "Accounts" }));
      await userEvent.click(screen.getByText("Add account", { selector: "summary" }));
      expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Sign in to manage the router" })).toBeNull();
    });
  }
});

describe("crash banner", () => {
  const crash = (id: string, at: string) => ({ id, at, kind: "exception" as const, code: "ERR_STREAM_UNABLE_TO_PIPE",
    message: "Error [ERR_STREAM_UNABLE_TO_PIPE]: Cannot pipe to a closed or destroyed stream", frame: "at done (~/aar/src/server.ts:266:9)" });

  it("shows the latest unacknowledged crash until the owner dismisses it", async () => {
    let crashes = [crash("a", "2026-10-25T15:10:00.000Z"), crash("b", "2026-10-25T15:18:24.000Z")];
    const app = await fakeApp({ overview: () => overview({ crashes }), "crashes/acknowledge": () => { crashes = []; return { acknowledged: true }; } }, { snapshots });
    await app.router.reload();
    app.render(<App />);
    const banner = screen.getByText(/The router crashed/).closest("#crash")!;
    expect(banner.textContent).toMatch(/The router crashed at .*\(and 1 earlier time\)/);
    expect(banner.textContent).toContain("Cannot pipe to a closed or destroyed stream · at done (~/aar/src/server.ts:266:9)");
    expect(banner.textContent).toContain("aar logs --crashes");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(app.called("crashes/acknowledge").map(c => c.body)).toEqual([{ id: "b" }]);
    expect(screen.queryByText(/The router crashed/)).toBeNull();
  });

  it("shows crashes to viewers without a dismiss control", async () => {
    const app = await fakeApp({ overview: () => overview({ crashes: [crash("a", "2026-10-25T15:18:24.000Z")] }) }, { access: "viewer", snapshots });
    await app.router.reload();
    app.render(<App />);
    expect(screen.getByText(/The router crashed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows nothing without crashes", async () => {
    const app = await fakeApp({}, { snapshots });
    await app.router.reload();
    app.render(<App />);
    expect(screen.queryByText(/The router crashed/)).toBeNull();
  });
});

describe("Fable quota display", () => {
  it("hides and restores the Fable meter even when a live snapshot includes it", async () => {
    const at = Date.now();
    const windows = [
      { bucket: "five_hour", windowMinutes: 300, usedPercent: 20, remainingPercent: 80, resetsAt: null, scope: "all" },
      { bucket: "seven_day", windowMinutes: 10080, usedPercent: 45, remainingPercent: 55, resetsAt: null, scope: "all" },
      { bucket: "seven_day_fable", windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: null, scope: "fable" },
    ];
    let showFableQuota = true;
    const app = await fakeApp({
      overview: () => overview({ showFableQuota, accounts: [account("work", { provider: "claude", windows })] }),
      "settings/show-fable-quota": body => ({ enabled: showFableQuota = body.enabled === true }),
    }, { snapshots: { ...snapshots, live: () => ({ at, scopes: {}, quotaAt: { work: at }, quota: { work: windows } }) } });
    await app.router.reload();
    app.render(<App />);
    const navigate = (name: string) => userEvent.click(screen.getByRole("tab", { name }));
    const panel = () => within(screen.getByRole("tabpanel"));
    const setting = () => panel().getByRole<HTMLInputElement>("checkbox", { name: "Show Fable weekly quota" });
    expect(panel().getByRole("meter", { name: "7d Fable" }).getAttribute("aria-valuenow")).toBe("100");

    await navigate("Settings");
    expect(setting().checked).toBe(true);
    await userEvent.click(setting());
    await navigate("Dashboard");
    expect(panel().queryByRole("meter", { name: "7d Fable" })).toBeNull();
    expect(panel().getAllByRole("meter").map(m => m.getAttribute("aria-label"))).toEqual(["5h", "7d all"]);
    await navigate("Accounts");
    expect(panel().queryByRole("progressbar", { name: "7d Fable remaining" })).toBeNull();

    await navigate("Settings");
    expect(setting().checked).toBe(false);
    await userEvent.click(setting());
    await navigate("Accounts");
    expect(panel().getByRole("progressbar", { name: "7d Fable remaining" }).getAttribute("value")).toBe("0");
  });
});

describe("limit resets", () => {
  it("badges resets expiring within a week, and opens an account from the Resets tab", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString(), later = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const resets = (expiresAt: string, available = 1) => ({ observedAt: soon, available, resets: [{ label: "Full reset", available, total: available, expiresAt, usableNow: true }] });
    const app = await fakeApp({ overview: () => overview({ accounts: [
      account("work", { nickname: "Work", provider: "claude", quota: { observedAt: soon, limitResets: resets(soon, 2) } }),
      account("home", { quota: { observedAt: soon, limitResets: resets(later) } }),
    ] }) }, { snapshots });
    await app.router.reload();
    app.render(<App />);
    await userEvent.click(screen.getByRole("tab", { name: "Resets 2 limit resets expire within a week" }));
    await userEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Work · claude" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Accounts");
    expect(document.activeElement?.id).toBe("account-work");
  });
});
