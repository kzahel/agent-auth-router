import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { ResetsTab } from "./ResetsTab.tsx";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const after = (ms: number) => new Date(Date.now() + ms).toISOString();
const resets = (rows: [string, string | null][], error?: string) => ({ observedAt: after(0), available: error ? null : rows.length,
  resets: rows.map(([label, expiresAt]) => ({ label, available: 1, total: 1, expiresAt, usableNow: true })), ...(error ? { error } : {}) });

describe("ResetsTab", () => {
  it("groups resets by how soon they expire, colors them, and opens an account", async () => {
    const app = await fakeApp({ overview: () => overview({ accounts: [
      account("work", { nickname: "Work", provider: "claude", quota: { observedAt: after(0), limitResets: resets([["Fable reset", after(10 * DAY)], ["Full reset", after(5.5 * HOUR)]]) } }),
      account("codex", { quota: { observedAt: after(0), limitResets: resets([["Full reset", after(3 * DAY + HOUR)], ["Spare", after(70 * DAY)]]) } }),
      account("broken", { provider: "claude", quota: { observedAt: after(0), limitResets: resets([], "limit-reset read denied") } }),
    ] }) });
    await app.router.reload();
    const onOpenAccount = vi.fn();
    app.render(<ResetsTab visible onOpenAccount={onOpenAccount} onOpenSettings={() => {}} />);
    expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["Under a day 1", "Under a week 1", "Under two weeks 1", "Later 1", "Not known"]);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map(r => r.getAttribute("data-urgency"))).toEqual(["day", "week", "fortnight", "later"]);
    expect(within(rows[0]!).getByText("in 5 hours").getAttribute("data-urgency")).toBe("day");
    expect(within(rows[1]!).getByText("in 3 days")).toBeTruthy();
    expect(within(rows[3]!).getByText("in 2 months")).toBeTruthy();
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Work · claude" }));
    expect(onOpenAccount).toHaveBeenLastCalledWith("work");
    expect(screen.getByText(": limit-reset read denied")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "broken" }));
    expect(onOpenAccount).toHaveBeenLastCalledWith("broken");
  });

  it("points to Settings when no resets have been read", async () => {
    const app = await fakeApp({ overview: () => overview({ accounts: [account("work")] }) });
    await app.router.reload();
    const onOpenSettings = vi.fn();
    app.render(<ResetsTab visible onOpenAccount={() => {}} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText(/No limit resets have been read/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
