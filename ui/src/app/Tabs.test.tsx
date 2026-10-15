import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { Tabs, type TabId } from "./Tabs.tsx";

function Harness() {
  const [tab, setTab] = useState<TabId>("dashboard");
  return <Tabs selected={tab} onSelect={setTab} />;
}

it("moves between tabs with the arrow keys, Home and End, with one tab stop", async () => {
  render(<Harness />);
  const selected = () => screen.getByRole("tab", { selected: true }).textContent;
  await userEvent.click(screen.getByRole("tab", { name: "Accounts" }));
  expect(selected()).toBe("Accounts");
  await userEvent.keyboard("{ArrowRight}");
  expect(selected()).toBe("Pools");
  expect(document.activeElement?.textContent).toBe("Pools");
  await userEvent.keyboard("{End}");
  expect(selected()).toBe("Settings");
  await userEvent.keyboard("{ArrowRight}");
  expect(selected()).toBe("Dashboard");
  await userEvent.keyboard("{ArrowLeft}{Home}");
  expect(selected()).toBe("Dashboard");
  expect(screen.getAllByRole("tab").filter(t => t.tabIndex === 0)).toHaveLength(1);
});
