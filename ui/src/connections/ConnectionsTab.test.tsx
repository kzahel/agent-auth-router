import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { ConnectionsTab } from "./ConnectionsTab.tsx";

const state = overview({
  accounts: [account("work", { nickname: "Work" })],
  pools: [{ id: "p1", name: "Team", provider: "codex", policy: "manual", revision: 1, accountIds: ["work"], bindings: [] }],
  integrations: [
    { id: "ya", name: "Yep Anywhere", revision: 4, revoked: false, poolIds: [], accountIds: [] },
    { id: "old", name: "Old laptop", revision: 1, revoked: true, poolIds: [], accountIds: [] },
  ],
});

describe("ConnectionsTab", () => {
  it("edits a connection's access, keeping choices while the router updates", async () => {
    const app = await fakeApp({ overview: () => state });
    await app.router.reload();
    app.render(<ConnectionsTab />);
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Manage access" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Manage access" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Team · codex" }));
    await app.router.reload();
    expect(screen.getByRole("checkbox", { name: "Team · codex" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(app.called("grants/save")).toEqual([{ operation: "grants/save", body: { id: "ya", revision: 4, poolIds: ["p1"], accountIds: [] } }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save access" })).toBeNull());
  });

  it("revokes a connection only after confirmation", async () => {
    const app = await fakeApp({ overview: () => state });
    await app.router.reload();
    app.render(<ConnectionsTab />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke integration" }));
    expect(screen.getByText(/Revoke Yep Anywhere\? Its session credentials will stop working/)).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(app.called("integrations/revoke")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Revoke integration" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(app.called("integrations/revoke")).toEqual([{ operation: "integrations/revoke", body: { id: "ya" } }]));
  });
});
