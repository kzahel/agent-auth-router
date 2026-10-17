import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RequestEntry } from "../protocol/types.ts";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { DashboardTab } from "./DashboardTab.tsx";

const state = overview({
  accounts: [account("work", { home: "/profiles/work", nickname: "Work" }), account("home")],
  pools: [{ id: "11111111-1111-1111-1111-111111111111", name: "Team", provider: "codex", policy: "manual", revision: 1, accountIds: ["work"], bindings: [] }],
});
const history = (body: Record<string, unknown>) => ({ range: body.range, scope: body.scope, bucketMs: 1000, count: 120, epoch: "e", start: 0, completeThrough: -1, series: {} });
const entry = (change: Partial<RequestEntry>): RequestEntry => ({
  id: 1, startedAt: Date.now(), endedAt: null, client: "laptop", accountId: "work", poolId: null, sessionId: "s1",
  route: "/v1/messages", model: "claude-x", status: null, outcome: "active", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  estimated: false, cost: null, costFlags: 0, ...change,
});

async function dashboard(visible = true) {
  // What the router keeps, newest first, for snapshots after resubscribing.
  const recent: RequestEntry[] = [];
  const app = await fakeApp({
    overview: () => state,
    "sessions/recent": () => ({ stored: true, sessions: [] }),
    "history/cost": () => ({ summary: { cost: 1.5, low: 1, requests: 3, unpriced: 0, estimated: 0 }, prices: { date: "2026-10-14" } }),
  }, { snapshots: { history, requests: () => ({ requests: [...recent] }), live: () => ({ at: Date.now(), epoch: "e", scopes: {} }), activity: () => ({ accounts: {} }) } });
  await app.router.reload();
  const view = app.render(<DashboardTab visible={visible} onAddAccount={() => {}} />);
  const request = (entry: RequestEntry) => {
    const index = recent.findIndex(r => r.id === entry.id);
    if (index >= 0) recent[index] = entry; else recent.unshift(entry);
    app.emit("requests", "request", entry);
  };
  return { app, view, request };
}

describe("DashboardTab", () => {
  it("subscribes only while shown", async () => {
    const { app, view } = await dashboard(false);
    expect(app.subscribed("history")).toEqual([]);
    view.rerender(<DashboardTab visible onAddAccount={() => {}} />);
    await waitFor(() => expect(app.subscribed("history")).toEqual([{ range: "2m", scope: "all", metrics: ["cacheRead", "cacheWrite", "input", "output"] }]));
    expect(app.subscribed("live")).toHaveLength(1);
    expect(app.subscribed("activity")).toEqual([{ range: "2m", metrics: ["cacheWrite", "input", "output"] }]);
  });

  it("follows the scope, range, units and legend, and remembers them", async () => {
    const { app } = await dashboard();
    await userEvent.selectOptions(screen.getByRole("combobox"), "Pool · Team");
    await userEvent.click(screen.getByRole("button", { name: "1 hour" }));
    await userEvent.click(screen.getByRole("button", { name: "Bytes" }));
    await waitFor(() => expect(app.subscribed("history")).toEqual([{ range: "1h", scope: "pool:11111111-1111-1111-1111-111111111111", metrics: ["bytesUp", "bytesSent", "bytesDown"] }]));
    await userEvent.click(screen.getByRole("button", { name: /^Downloaded/ }));
    await waitFor(() => expect(app.subscribed("activity")).toEqual([{ range: "1h", metrics: ["bytesUp", "bytesSent"] }]));
    expect(localStorage.getItem("dash-units")).toBe("bytes");
    expect(JSON.parse(localStorage.getItem("dash-hidden")!)).toEqual(["cacheRead", "bytesDown"]);
    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));
    await waitFor(() => expect(app.subscribed("history")[0]).toMatchObject({ range: "2m", scope: "all" }));
    expect(screen.getByRole("button", { name: "Reset view" })).toHaveProperty("disabled", true);
    expect(localStorage.getItem("dash-units")).toBeNull();
  });

  it("shows requests as they stream and finish, scoped to the selection", async () => {
    const { app, request } = await dashboard();
    await waitFor(() => expect(app.subscribed("requests")).toHaveLength(1));
    // After the snapshot, which replaces the list.
    await new Promise(resolve => setTimeout(resolve, 0));
    request(entry({ id: 1 }));
    request(entry({ id: 2, accountId: "home", outcome: "ok", status: 200, endedAt: Date.now() }));
    const requests = () => within(document.getElementById("dash-requests")!);
    await waitFor(() => expect(requests().getAllByRole("row")).toHaveLength(3));
    expect(requests().getByText("streaming")).toBeTruthy();
    request(entry({ id: 1, outcome: "ok", status: 200, endedAt: Date.now(), usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 } }));
    await waitFor(() => expect(requests().queryByText("streaming")).toBeNull());
    await userEvent.selectOptions(screen.getByRole("combobox"), "Account · home");
    await waitFor(() => expect(requests().getAllByRole("row")).toHaveLength(2));
    expect(requests().getByText("laptop → home")).toBeTruthy();
  });

  it("shows the range's cost at API rates in the legend", async () => {
    await dashboard();
    expect((await screen.findByText("$1.50 at API rates")).title).toMatch(/Estimated cost of these 3 requests .*genai-prices 2026-10-14/);
  });

  it("names accounts by nickname or folder, and highlights those in scope", async () => {
    await dashboard();
    const accounts = document.getElementById("dash-accounts")!;
    expect(within(accounts).getByText("Work").closest("td")!.title).toBe("Work · codex");
    expect(within(accounts).getByText("home").closest("td")!.title).toBe("home · codex");
    await userEvent.selectOptions(screen.getByRole("combobox"), "Pool · Team");
    const rows = within(accounts).getAllByRole("row").slice(1);
    expect(rows.map(r => !!r.className)).toEqual([true, false]);
  });
});
