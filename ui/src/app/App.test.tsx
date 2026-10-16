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
