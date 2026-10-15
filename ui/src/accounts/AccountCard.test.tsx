import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { account, fakeApp } from "../test/fake-app.tsx";
import { AccountCard } from "./AccountCard.tsx";

const props = { login: undefined, presentation: "external" as const, onEditNickname: () => {}, onRemove: async () => {} };

describe("AccountCard", () => {
  it("shows quota windows, with no bar value when the remaining share is unknown", async () => {
    const app = await fakeApp();
    app.render(<AccountCard {...props} account={account("work", { windows: [
      { bucket: "primary", windowMinutes: 300, usedPercent: 32, remainingPercent: 68, resetsAt: null, scope: "all" },
      { bucket: "secondary", windowMinutes: null, usedPercent: null, remainingPercent: null, resetsAt: null, scope: "all" },
    ] })} />);
    expect(screen.getByText("primary · 68% left")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "primary remaining" }).getAttribute("value")).toBe("68");
    expect(screen.getByRole("progressbar", { name: "secondary remaining" }).getAttribute("value")).toBeNull();
    expect(screen.getAllByText("Reset time unknown · scope: all", { selector: "small" })).toHaveLength(2);
  });

  it("folds More after one of its actions is chosen", async () => {
    const app = await fakeApp();
    const onEditNickname = vi.fn();
    const { container } = app.render(<AccountCard {...props} onEditNickname={onEditNickname} account={account("work")} />);
    const more = container.querySelector("details")!;
    await userEvent.click(screen.getByText("More"));
    expect(more.open).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Edit nickname" }));
    expect(onEditNickname).toHaveBeenCalled();
    expect(more.open).toBe(false);
  });

  it("asks before disabling, and does nothing when cancelled", async () => {
    const app = await fakeApp();
    app.render(<AccountCard {...props} account={account("work", { bindingCount: 2 })} />);
    await userEvent.click(screen.getByText("More"));
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(screen.getByText(/Disable work\? 2 session pins reference this account/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(app.called("accounts/set-enabled")).toHaveLength(0);
    await userEvent.click(screen.getByText("More"));
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(app.called("accounts/set-enabled")).toEqual([{ operation: "accounts/set-enabled", body: { id: "work", revision: 1, enabled: false } }]));
  });

  it("shows the official login command in a browser, and opens the terminal on the desktop", async () => {
    const web = await fakeApp({ "accounts/login-command": () => ({ command: "CODEX_HOME=/profiles/work codex login" }) });
    const { unmount } = web.render(<AccountCard {...props} account={account("work")} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByText("CODEX_HOME=/profiles/work codex login")).tagName).toBe("PRE");
    unmount();
    const terminalLogin = vi.fn(async () => ({}));
    const desktop = await fakeApp({}, { native: { terminalLogin } });
    desktop.render(<AccountCard {...props} presentation="embedded" account={account("work")} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(terminalLogin).toHaveBeenCalledWith("work", "embedded"));
    expect(desktop.called("accounts/login-command")).toHaveLength(0);
  });

  it("keeps Remove for retired accounts, without More", async () => {
    const app = await fakeApp();
    app.render(<AccountCard {...props} account={account("old", { retired: true, enabled: false })} />);
    expect(screen.getByText("Retired · credential profile retained")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByText("More")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
