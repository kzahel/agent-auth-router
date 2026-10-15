import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { account, fakeApp, overview } from "../test/fake-app.tsx";
import { Diagnostics } from "./Diagnostics.tsx";

it("keeps explicit checks scoped, preserves typed filtering during results, and copies only the server's sanitized report", async () => {
  let complete: (value: object) => void = () => {};
  const report = { version: 1, at: new Date().toISOString(), mode: "passive", findings: [
    { code: "profile-endpoint-override", status: "error", subject: "account:work", observedAt: new Date().toISOString(), message: "Profile configuration conflicts with direct official CLI authentication.", action: "accounts" },
  ], copyText: "sanitized report", exitCode: 1 };
  const app = await fakeApp({ overview: () => overview({ accounts: [account("work")] }), diagnostics: () => new Promise(resolve => { complete = resolve; }) });
  const navigate = vi.fn(), user = userEvent.setup({ delay: 1 });
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  app.render(<Diagnostics onNavigate={navigate} />);
  expect((screen.getByRole("button", { name: "Check sign-in" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Run diagnostics" }));
  expect(app.called("diagnostics")[0]?.body).toEqual({});
  const field = screen.getByRole("searchbox", { name: "Filter diagnostics" });
  await user.type(field, "profile");
  complete(report);
  await user.type(field, "-endpoint-override");
  await waitFor(() => expect((field as HTMLInputElement).value).toBe("profile-endpoint-override"));
  await user.click(screen.getByRole("button", { name: "Copy report" }));
  expect(copy).toHaveBeenCalledWith("sanitized report");
  await user.click(screen.getByRole("button", { name: "Open Accounts" }));
  expect(navigate).toHaveBeenCalledWith("accounts");
  await user.selectOptions(screen.getByRole("combobox", { name: "Diagnostic account" }), "work");
  await user.click(screen.getByRole("button", { name: "Check sign-in" }));
  expect(app.called("diagnostics")[1]?.body).toEqual({ accountId: "work", checkLogin: true });
  complete({ ...report, accountId: "work", mode: "check-login" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(app.called("diagnostics")[2]?.body).toEqual({ accountId: "work", refreshUsage: true });
  complete(report);
});
