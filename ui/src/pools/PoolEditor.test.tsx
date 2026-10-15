import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Pool } from "../protocol/types.ts";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { PoolEditor } from "./PoolEditor.tsx";

const pool: Pool = { id: "p1", name: "Work", provider: "codex", policy: "manual", revision: 2, accountIds: ["a"], bindings: [{ accountId: "a", count: 3 }] };
const state = overview({
  accounts: [account("a"), account("b", { enabled: false }), account("c", { provider: "claude" })],
  pools: [pool],
  integrations: [
    { id: "ya", name: "Yep Anywhere", revision: 5, revoked: false, poolIds: [], accountIds: ["c"] },
    { id: "old", name: "Old", revision: 1, revoked: true, poolIds: [], accountIds: [] },
  ],
});

describe("PoolEditor", () => {
  it("saves the pool, then grants the connections it was shared with", async () => {
    const app = await fakeApp({ overview: () => state });
    await app.router.reload();
    app.render(<PoolEditor pool={pool} overview={state} onClose={() => {}} />);
    expect(screen.getByText("3 session pins reference this pool. Removing a member or deleting the pool blocks subsequent requests for affected pins.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("checkbox", { name: "Old" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "/profiles/b · disabled" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "/profiles/c" })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "/profiles/b · disabled" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Default policy" }), "weekly-pace");
    await userEvent.click(screen.getByRole("checkbox", { name: "Yep Anywhere" }));
    await userEvent.click(screen.getByRole("button", { name: "Save pool" }));
    await waitFor(() => expect(app.called("grants/save")).toHaveLength(1));
    expect(app.called("pools/save")[0]!.body).toEqual({ id: "p1", revision: 2, name: "Work", provider: "codex", policy: "weekly-pace", accountIds: ["a", "b"] });
    expect(app.called("grants/save")[0]!.body).toEqual({ id: "ya", revision: 5, poolIds: ["p1"], accountIds: ["c"] });
  });

  it("starts a new pool empty, and clears members when the provider changes", async () => {
    const app = await fakeApp();
    app.render(<PoolEditor pool={undefined} overview={state} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete pool" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Pool name" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "/profiles/a" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "claude");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "codex");
    expect(screen.getByRole("checkbox", { name: "/profiles/a" })).toHaveProperty("checked", false);
  });
});
