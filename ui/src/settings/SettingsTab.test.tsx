import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApp, overview } from "../test/fake-app.tsx";
import { SettingsTab } from "./SettingsTab.tsx";

const settings = { presentation: "external" as const, onPresentation: () => {}, onNavigate: () => {} };

describe("SettingsTab", () => {
  it("loads settings when shown, keeps a retention set elsewhere selectable, and saves forever as null", async () => {
    const app = await fakeApp({
      "history/settings": () => ({ stored: true, retentionDays: 14 }),
      "settings/request-compression": () => ({ requestCompression: { claude: "gzip", codex: "off" } }),
    });
    const view = app.render(<SettingsTab visible={false} {...settings} />);
    expect(app.called("history/settings")).toHaveLength(0);
    view.rerender(<SettingsTab visible {...settings} />);
    const retention = screen.getByRole("combobox", { name: "Keep history" });
    await waitFor(() => expect(retention).toHaveProperty("value", "14"));
    expect(screen.getByRole("option", { name: "14 days" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Claude" })).toHaveProperty("value", "gzip");
    await userEvent.selectOptions(retention, "forever");
    await waitFor(() => expect(app.called("history/set-retention")).toEqual([{ operation: "history/set-retention", body: { retentionDays: null } }]));
  });

  it("says when history is not stored", async () => {
    const app = await fakeApp({ "history/settings": () => ({ stored: false, retentionDays: 30 }) });
    app.render(<SettingsTab visible {...settings} />);
    expect(await screen.findByText("History is not stored: the router could not open its database.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Keep history" })).toHaveProperty("disabled", true);
  });

  it("puts a refused compression choice back", async () => {
    const app = await fakeApp({
      "settings/request-compression": (body) => {
        if (body.value) throw new Error("value must be one of off, gzip");
        return { requestCompression: { claude: "off", codex: "off" } };
      },
    });
    app.render(<SettingsTab visible {...settings} />);
    const claude = screen.getByRole("combobox", { name: "Claude" });
    await userEvent.selectOptions(claude, "gzip");
    expect(await screen.findByText("value must be one of off, gzip")).toBeTruthy();
    await waitFor(() => expect(claude).toHaveProperty("value", "off"));
  });

  it("turns limit resets on and off, and puts a refused change back", async () => {
    let enabled = false, refuse = false;
    const app = await fakeApp({
      "settings/limit-resets": (body) => {
        if (refuse && body.enabled !== undefined) throw new Error("synthetic refusal");
        if (typeof body.enabled === "boolean") enabled = body.enabled;
        return { enabled };
      },
    });
    app.render(<SettingsTab visible {...settings} />);
    const box = screen.getByRole("checkbox", { name: "Show limit resets" });
    await waitFor(() => expect(app.called("settings/limit-resets")).toHaveLength(1));
    expect(box).toHaveProperty("checked", false);
    await userEvent.click(box);
    await waitFor(() => expect(box).toHaveProperty("checked", true));
    expect(app.called("settings/limit-resets").at(-1)).toEqual({ operation: "settings/limit-resets", body: { enabled: true } });
    expect(await screen.findByText(/after its next usage check/)).toBeTruthy();
    refuse = true;
    await userEvent.click(box);
    expect(await screen.findByText("synthetic refusal")).toBeTruthy();
    await waitFor(() => expect(box).toHaveProperty("checked", true));
  });

  it("shows the Antigravity warning and terms link before the owner opts in, and puts a refused change back", async () => {
    let enabled = false, refuse = false;
    const operation = "settings/experimental-providers";
    const app = await fakeApp({
      [operation]: (body) => {
        if (refuse && body.enabled !== undefined) throw new Error("synthetic refusal");
        if (typeof body.enabled === "boolean") enabled = body.enabled;
        return { providers: { antigravity: enabled } };
      },
    });
    app.render(<SettingsTab visible {...settings} />);
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: "Enable experimental Antigravity routing" });
    expect(box).toHaveProperty("disabled", true);
    await waitFor(() => expect(box).toHaveProperty("disabled", false));
    expect(box).toHaveProperty("checked", false);
    expect(screen.getByText(/can break when Antigravity changes\. Google may restrict account access for unsupported third-party use/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Google's Antigravity terms" })).toHaveProperty("href", "https://antigravity.google/terms");
    await userEvent.click(box);
    await waitFor(() => expect(box).toHaveProperty("checked", true));
    expect(app.called(operation).at(-1)).toEqual({ operation, body: { provider: "antigravity", enabled: true } });
    refuse = true;
    await userEvent.click(box);
    expect(await screen.findByText("synthetic refusal")).toBeTruthy();
    await waitFor(() => expect([box.checked, box.disabled]).toEqual([true, false]));
  });

  it("shows desktop controls only in the desktop app, and Log out only in a browser", async () => {
    const web = await fakeApp();
    const { unmount } = web.render(<SettingsTab visible {...settings} />);
    expect(screen.queryByText("Launch at login")).toBeNull();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    unmount();
    const desktop = await fakeApp({}, { native: { startup: async () => true } });
    desktop.render(<SettingsTab visible {...settings} />);
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Launch at login" })).toHaveProperty("checked", true));
  });

  it("installs an update only after confirmation, and reports a failed install", async () => {
    let reject: (reason: unknown) => void = () => {};
    const installUpdate = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const app = await fakeApp({}, { native: { checkUpdate: async () => ({ version: "0.2.0" }), installUpdate } });
    app.render(<SettingsTab visible {...settings} />);
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    const install = await screen.findByRole("button", { name: "Install update & relaunch" });
    expect(screen.getByText(/Version 0.2.0 is available/)).toBeTruthy();
    await userEvent.click(install);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(installUpdate).not.toHaveBeenCalled();
    await userEvent.click(install);
    await userEvent.click(screen.getByRole("button", { name: "Install & relaunch" }));
    expect(installUpdate).toHaveBeenCalledWith("0.2.0");
    expect(install).toHaveProperty("disabled", true);
    reject("Synthetic download failure");
    expect(await screen.findByText("Update failed: Synthetic download failure")).toBeTruthy();
    await waitFor(() => expect(install).toHaveProperty("disabled", false));
  });

  it("stops the router after confirmation, and says how to start it again", async () => {
    const app = await fakeApp({ overview: () => overview({ routerId: "r1" }) });
    await app.router.reload();
    app.render(<SettingsTab visible {...settings} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop router" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(app.called("stop")).toEqual([{ operation: "stop", body: { routerId: "r1" } }]));
    expect(app.router.stoppedByOwner).toBe(true);
    await waitFor(() => expect(app.router.view.status.message).toBe("Router stopped. Start it again with aar serve."));
  });
});
