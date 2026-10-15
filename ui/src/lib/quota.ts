import type { QuotaWindow } from "../protocol/types.ts";

// Matches the router's DISPLAY_QUOTA_STALE_MS: an open dashboard has it
// reprobe readings this old, so older ones are drawn as last known.
export const QUOTA_STALE_MS = 15 * 60_000;

/** five_hour → 5h, seven_day_opus → 7d opus, codex:primary over 300 minutes → 5h. */
export function quotaLabel(w: Pick<QuotaWindow, "bucket"> & { windowMinutes?: number | null }): string {
  const name = w.bucket.replace(/^codex:/, "").replace(/^five_hour/, "5h").replace(/^seven_day/, "7d").replaceAll("_", " ");
  const m = w.windowMinutes;
  if (!/^(primary|secondary)$/.test(name) || !m) return name;
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

/** How much of the window has passed, in percent; null when unknown. */
export function elapsedPercent(w: QuotaWindow, now = Date.now()): number | null {
  if (!w.windowMinutes || !w.resetsAt) return null;
  const elapsed = 1 - (Date.parse(w.resetsAt) - now) / (w.windowMinutes * 60_000);
  return elapsed >= 0 && elapsed <= 1 ? elapsed * 100 : null;
}

export const tenth = (value: number) => Math.round(value * 10) / 10;
