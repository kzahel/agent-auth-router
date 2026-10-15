import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { RemovalPreview } from "../protocol/types.ts";
import { fakeApp } from "../test/fake-app.tsx";
import { RemoveAccountDialog } from "./RemoveAccountDialog.tsx";

const preview = (change: Partial<RemovalPreview> = {}): RemovalPreview =>
  ({ id: "work", revision: 3, home: "/profiles/work", canDeleteProfile: true, deleteIdentity: "1:fixture", reason: "Permanently deletes this folder.", ...change });

function Harness({ initial }: { initial: RemovalPreview }) {
  const [shown, setShown] = useState<RemovalPreview>();
  return (
    <>
      <button type="button" onClick={() => setShown({ ...initial })}>Open</button>
      <RemoveAccountDialog preview={shown} onClose={() => setShown(undefined)} onRemoved={() => {}} />
    </>
  );
}

describe("RemoveAccountDialog", () => {
  it("keeps the folder unless chosen each time, and focuses Cancel", async () => {
    const app = await fakeApp();
    app.render(<Harness initial={preview()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement?.textContent).toBe("Cancel");
    await userEvent.click(screen.getByRole("checkbox", { name: "Also delete the profile folder" }));
    expect(screen.getByRole("button", { name: "Remove & delete folder" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("checkbox", { name: "Also delete the profile folder" })).toHaveProperty("checked", false);
    await userEvent.click(screen.getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(app.called("accounts/remove")).toHaveLength(1));
    expect(app.called("accounts/remove")[0]!.body).toEqual({ id: "work", revision: 3, deleteProfile: false });
  });

  it("sends the folder and its identity only when deleting it, and shows failures in the dialog", async () => {
    let fail = true;
    const app = await fakeApp({ "accounts/remove": () => { if (fail) throw new Error("Router busy; finish sign-ins before removing it."); return {}; } });
    app.render(<Harness initial={preview()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Also delete the profile folder" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove & delete folder" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Router busy/);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Remove & delete folder" }));
    await waitFor(() => expect(app.called("accounts/remove")).toHaveLength(2));
    expect(app.called("accounts/remove")[1]!.body).toEqual({ id: "work", revision: 3, deleteProfile: true, home: "/profiles/work", deleteIdentity: "1:fixture" });
  });

  it("cannot delete folders the router may not delete", async () => {
    const app = await fakeApp();
    app.render(<Harness initial={preview({ canDeleteProfile: false, reason: "Imported profiles are kept." })} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("checkbox", { name: "Also delete the profile folder" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Imported profiles are kept.")).toBeTruthy();
  });
});
