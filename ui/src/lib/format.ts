// Number, byte, cost and age formatting shared by the tabs and the charts.

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return abs >= 10 || value === 0 ? String(Math.round(value)) : value.toFixed(1);
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(Math.abs(value) >= 100 ? 0 : 1) : Math.round(value)} ${units[unit]}`;
}

// history.ts COST_* bits that make a cost partly estimated.
export const COST_ESTIMATED = 1 | 2 | 8;

export function formatCost(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`;
  if (value >= 0.01 || value === 0) return `$${value.toFixed(2)}`;
  return "<$0.01";
}

export function costTitle(estimated: boolean, unpriced: number): string {
  return ["At the providers' published API prices; subscription accounts are not billed this.",
    ...(estimated ? ["Partly estimated: cache writes recorded before the router noted their duration (priced as 1-hour), or output never reported."] : []),
    ...(unpriced ? [`${unpriced} requests have no price for their model.`] : [])].join(" ");
}

/** "12 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
