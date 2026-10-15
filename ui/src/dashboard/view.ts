// What the Dashboard shows: range, scope, units, the activity list and the
// series switched off in the legend, remembered per browser.

import { useState } from "react";
import { formatBytes, formatNumber } from "../lib/format.ts";
import type { RangeName } from "../protocol/types.ts";

export const RANGES: [RangeName, string][] = [["2m", "2 min"], ["10m", "10 min"], ["1h", "1 hour"], ["24h", "24 hours"], ["30d", "30 days"]];
export const LIVE_RANGES = new Set<RangeName>(["2m", "10m", "1h"]);
export type SeriesKey = "cacheRead" | "cacheWrite" | "input" | "output" | "bytesUp" | "bytesSent" | "bytesDown";
export type Units = "tokens" | "bytes";
export type Activity = "requests" | "sessions";

// Output is drawn over the input bands, so the three token series take the
// palette's first three slots, which validate as distinct in every pairing in
// both modes. Cache read is background volume, off by default, in a neutral.
export const SERIES: Record<SeriesKey, { label: string; slot: number | "neutral" }> = {
  cacheRead: { label: "Cache read", slot: "neutral" },
  cacheWrite: { label: "Cache write", slot: 2 },
  input: { label: "Uncached input", slot: 3 },
  output: { label: "Output", slot: 1 },
  bytesUp: { label: "Uploaded", slot: 1 },
  // What the router sent on: smaller than Uploaded when it compresses requests.
  bytesSent: { label: "Sent upstream", slot: 2 },
  bytesDown: { label: "Downloaded", slot: 4 },
};

export interface PaneSpec {
  title: string;
  series: SeriesKey[];
  line?: SeriesKey[];
  stacked?: boolean;
  format(value: number): string;
  unit: string;
}

// Tokens share one axis: new input and output are of similar size. Bytes keep
// two panes, since uploads (whole contexts) dwarf downloads.
export const panes = (units: Units): PaneSpec[] => units === "tokens"
  ? [{ title: "Tokens per second", series: ["cacheRead", "cacheWrite", "input", "output"], line: ["output"], stacked: true, format: formatNumber, unit: "/s" }]
  : [
    { title: "Uploaded · per second", series: ["bytesUp", "bytesSent"], format: formatBytes, unit: "/s" },
    { title: "Downloaded · per second", series: ["bytesDown"], format: formatBytes, unit: "/s" },
  ];

export interface View { range: RangeName; scope: string; units: Units; activity: Activity; hidden: SeriesKey[] }

// The view a new browser starts with, and what Reset view returns to.
export const DEFAULT_VIEW: View = { range: "2m", scope: "all", units: "tokens", activity: "requests", hidden: ["cacheRead"] };
const KEYS: Record<keyof View, string> = { range: "dash-range", scope: "dash-scope", units: "dash-units", activity: "dash-activity", hidden: "dash-hidden" };

export function storedView(): View {
  const range = localStorage.getItem(KEYS.range);
  // Series switched off in the legend. Cache reads start off: nearly all of what
  // is sent and cheap, they would flatten the costlier tokens to a hairline.
  let hidden = DEFAULT_VIEW.hidden;
  try {
    const stored = JSON.parse(localStorage.getItem(KEYS.hidden) ?? "null") as unknown;
    if (Array.isArray(stored)) hidden = stored.filter((key): key is SeriesKey => typeof key === "string" && key in SERIES);
  } catch { /* The default applies. */ }
  return {
    range: RANGES.find(([key]) => key === range)?.[0] ?? DEFAULT_VIEW.range,
    scope: localStorage.getItem(KEYS.scope) ?? DEFAULT_VIEW.scope,
    units: localStorage.getItem(KEYS.units) === "bytes" ? "bytes" : DEFAULT_VIEW.units,
    activity: localStorage.getItem(KEYS.activity) === "sessions" ? "sessions" : DEFAULT_VIEW.activity,
    hidden,
  };
}

export const isDefaultView = (view: View) => view.range === DEFAULT_VIEW.range && view.scope === DEFAULT_VIEW.scope
  && view.units === DEFAULT_VIEW.units && view.activity === DEFAULT_VIEW.activity
  && [...view.hidden].sort().join() === [...DEFAULT_VIEW.hidden].sort().join();

/** The view, a setter that remembers changes, and a reset that forgets them. */
export function useView(): [View, (change: Partial<View>) => void, () => void] {
  const [view, setView] = useState(storedView);
  const change = (next: Partial<View>) => {
    for (const [key, value] of Object.entries(next) as [keyof View, View[keyof View]][])
      localStorage.setItem(KEYS[key], typeof value === "string" ? value : JSON.stringify(value));
    setView(current => ({ ...current, ...next }));
  };
  const reset = () => {
    for (const key of Object.values(KEYS)) localStorage.removeItem(key);
    setView(DEFAULT_VIEW);
  };
  return [view, change, reset];
}

export const rangeSpan = (range: RangeName) => RANGES.find(([key]) => key === range)![1].replace(/^1 /, "");
