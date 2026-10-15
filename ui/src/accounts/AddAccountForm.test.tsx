import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeApp } from "../test/fake-app.tsx";
import { AddAccountForm } from "./AddAccountForm.tsx";

const submit = () => screen.getByRole("button", { name: /Add account|Adding…|Checking & adding…/ });

describe("AddAccountForm", () => {
  it("creates a dedicated profile with only the fields that apply", async () => {
    const app = await fakeApp();
    app.render(<AddAccountForm />);
    await userEvent.click(submit());
    await waitFor(() => expect(app.called("accounts/add")).toHaveLength(1));
    expect(app.called("accounts/add")[0]!.body).toEqual({ provider: "codex", nickname: "" });
  });

  it("enrolls an existing profile chosen from those found, and keeps it after a failure", async () => {
    let fail = true;
    const app = await fakeApp({
      "profiles/discover": () => ({ profiles: [{ home: "/Users/example/.codex", enrolled: false }, { home: "/Users/example/old", enrolled: true }] }),
      "accounts/add": () => { if (fail) throw new Error("Existing profile folder is missing or unreadable"); return {}; },
    });
    app.render(<AddAccountForm />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Profile setup" }), "existing");
    await userEvent.click(screen.getByRole("button", { name: "Find profiles" }));
    expect(screen.getByRole("button", { name: "/Users/example/old · already enrolled" })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "/Users/example/.codex" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Nickname (optional)" }), "Home");
    await userEvent.click(submit());
    await screen.findByText(/Existing profile folder is missing or unreadable/);
    expect(screen.getByRole("textbox", { name: "Profile folder" })).toHaveProperty("value", "/Users/example/.codex");
    expect(app.called("profiles/inspect")).toHaveLength(0);
    fail = false;
    await userEvent.click(submit());
    await waitFor(() => expect(app.called("accounts/add")).toHaveLength(2));
    expect(app.called("accounts/add")[1]!.body).toEqual({ enrollment: "existing", provider: "codex", home: "/Users/example/.codex", credentialStore: "auto", nickname: "Home" });
    // Success resets the form.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Profile folder" })).toHaveProperty("value", ""));
  });

  it("drops a profile check answered after the setup changed", async () => {
    let answer: (value: unknown) => void = () => {};
    const app = await fakeApp({ "profiles/inspect": () => new Promise(resolve => { answer = resolve; }) });
    app.render(<AddAccountForm />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Profile setup" }), "existing");
    await userEvent.type(screen.getByRole("textbox", { name: "Profile folder" }), "/a");
    await userEvent.click(screen.getByRole("button", { name: "Check profile" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Profile folder" }), "b");
    answer({ credentialStore: "file", credentialStatus: "ok", detail: "readable" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
