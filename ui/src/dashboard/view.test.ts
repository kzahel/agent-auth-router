import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, isDefaultView, storedView } from "./view.ts";

describe("dashboard view", () => {
  it("starts from the defaults and ignores stored values it does not know", () => {
    expect(storedView()).toEqual(DEFAULT_VIEW);
    localStorage.setItem("dash-range", "1y");
    localStorage.setItem("dash-units", "bits");
    localStorage.setItem("dash-hidden", "not json");
    expect(storedView()).toEqual(DEFAULT_VIEW);
    localStorage.setItem("dash-hidden", JSON.stringify(["output", "nonsense"]));
    localStorage.setItem("dash-range", "24h");
    localStorage.setItem("dash-activity", "sessions");
    expect(storedView()).toMatchObject({ range: "24h", activity: "sessions", hidden: ["output"] });
  });

  it("treats the hidden series as a set", () => {
    expect(isDefaultView({ ...DEFAULT_VIEW })).toBe(true);
    expect(isDefaultView({ ...DEFAULT_VIEW, hidden: [] })).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, hidden: ["output", "cacheRead"] })).toBe(false);
    expect(isDefaultView({ ...DEFAULT_VIEW, scope: "pool:x" })).toBe(false);
  });
});
