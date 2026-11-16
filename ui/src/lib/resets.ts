// Granted limit resets across accounts: how soon each expires, and how urgent that is.
import type { Account, LimitReset } from "../protocol/types.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** Closer expiry, stronger warning: under a day, a week, two weeks. */
export type ResetUrgency = "expired" | "day" | "week" | "fortnight" | "later" | "unknown";

export function resetUrgency(expiresAt: string | null, now = Date.now()): ResetUrgency {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return "unknown";
  const left = at - now;
  return left <= 0 ? "expired" : left < DAY ? "day" : left < 7 * DAY ? "week" : left < 14 * DAY ? "fortnight" : "later";
}

/** "in 5 hours", "in 24 days", "in 3 months"; whole units, rounded down. */
export function expiresIn(expiresAt: string | null, now = Date.now()): string {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return "no expiry reported";
  const left = at - now;
  if (left <= 0) return "expired";
  const unit = (n: number, name: string) => `in ${n} ${name}${n === 1 ? "" : "s"}`;
  if (left < HOUR) return unit(Math.max(1, Math.floor(left / 60_000)), "minute");
  if (left < DAY) return unit(Math.floor(left / HOUR), "hour");
  if (left < 60 * DAY) return unit(Math.floor(left / DAY), "day");
  return unit(Math.floor(left / (30 * DAY)), "month");
}

export const URGENCY_LABEL: Record<ResetUrgency, string> = {
  expired: "Expired", day: "Under a day", week: "Under a week", fortnight: "Under two weeks", later: "Later", unknown: "No expiry",
};

export interface AccountReset extends LimitReset { account: Account }

/** Every reset with resets left, soonest expiry first; those without an expiry last. */
export function allResets(accounts: Account[]): AccountReset[] {
  const rows = accounts.flatMap(account => (account.quota?.limitResets?.resets ?? []).filter(r => r.available > 0).map(r => ({ ...r, account })));
  const at = (r: AccountReset) => r.expiresAt ? Date.parse(r.expiresAt) || Infinity : Infinity;
  return rows.sort((a, b) => (at(a) - at(b)) || 0);
}

/** Resets left that expire within a week, for the tab's badge. */
export function soonCount(accounts: Account[], now = Date.now()): number {
  return allResets(accounts).filter(r => ["day", "week"].includes(resetUrgency(r.expiresAt, now))).reduce((sum, r) => sum + r.available, 0);
}

/** The nickname, else the id; a generated UUID id is shortened to its first part. */
export const accountName = (a: Account) => a.nickname ?? (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a.id) ? `${a.id.slice(0, 8)}…` : a.id);
