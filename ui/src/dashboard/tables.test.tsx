import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestEntry } from "../protocol/types.ts";
import { QuotaCell } from "./AccountsTable.tsx";
import { RequestsTable } from "./ActivityTables.tsx";

const cell = (props: Parameters<typeof QuotaCell>[0]) => render(<table><tbody><tr><QuotaCell {...props} /></tr></tbody></table>).container.querySelector("td")!;

describe("quota cell", () => {
  const window = { bucket: "five_hour", windowMinutes: 300, usedPercent: 85, remainingPercent: 15, resetsAt: null };

  it("says why there is no reading", () => {
    expect(cell({ windows: [], at: NaN, checking: true, error: "boom" }).textContent).toBe("checking…");
    const failed = cell({ windows: [], at: NaN, checking: false, error: "boom" });
    expect(failed.textContent).toBe("check failed");
    expect(failed.title).toBe("boom");
    expect(cell({ windows: [{ ...window, usedPercent: null }], at: NaN, checking: false, error: undefined }).textContent).toBe("not checked");
  });

  it("marks warning levels, and fades readings older than fifteen minutes with their age", () => {
    const fresh = cell({ windows: [window, { ...window, bucket: "seven_day", usedPercent: 120 }], at: Date.now(), checking: false, error: undefined });
    const meters = fresh.querySelectorAll("[data-bucket]");
    expect([...meters].map(m => m.getAttribute("data-level"))).toEqual(["warning", "critical"]);
    expect([...meters].map(m => m.textContent)).toEqual(["5h85%", "7d100%"]);
    expect(within(fresh).queryByText(/as of/)).toBeNull();
    const old = cell({ windows: [window], at: Date.now() - 20 * 60_000, checking: false, error: undefined });
    expect(within(old).getByText("as of 20 min ago")).toBeTruthy();
  });
});

describe("requests table", () => {
  const request = (change: Partial<RequestEntry>): RequestEntry => ({
    id: 1, startedAt: Date.now() - 2000, endedAt: Date.now(), client: "laptop", accountId: "work", poolId: null, sessionId: null,
    route: "/v1/messages", model: "claude-x", status: 200, outcome: "ok", usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
    estimated: false, cost: 0.0123, costFlags: 0, ...change,
  });

  it("marks estimates, streaming and cancelled requests", () => {
    render(<RequestsTable label={(id) => `#${id}`} requests={[
      request({ id: 3, outcome: "active", endedAt: null, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: null, status: null }),
      request({ id: 2, outcome: "client_closed", estimated: true, costFlags: 2 }),
      request({ id: 1, outcome: "error", status: 529, cost: null }),
    ]} />);
    const rows = screen.getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell").map(c => c.textContent));
    expect(rows[0]!.slice(1)).toEqual(["laptop → #work", "claude-x", "–", "–", "–", rows[0]![6], "streaming"]);
    expect(rows[1]!.slice(3)).toEqual(["1.0k (90% cached)", "~50", "~$0.01", "2.0 s", "cancelled"]);
    expect(rows[2]![7]).toBe("529");
    expect(rows[2]![5]).toBe("–");
  });

  it("is hidden without requests", () => {
    render(<RequestsTable label={(id) => id} requests={[]} />);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
