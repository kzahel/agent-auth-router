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
    for (const name of ["Accounts", "Pools", "Connections", "Settings"]) {
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
