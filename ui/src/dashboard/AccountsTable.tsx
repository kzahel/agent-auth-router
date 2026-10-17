import { useEffect, useRef } from "react";
import { sparkline } from "../chart/traffic-graph.ts";
import { accountName } from "../lib/accounts.ts";
import { ago, formatBytes, formatNumber } from "../lib/format.ts";
import { QUOTA_STALE_MS, elapsedPercent, quotaLabel, tenth } from "../lib/quota.ts";
import type { Account, ActivityData, Counter, LiveSnapshot, QuotaWindow, RequestEntry } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import styles from "./dashboard.module.css";
import { cssVariable, useColorScheme } from "./hooks.ts";
import type { Units } from "./view.ts";

const sent = (rate: Record<Counter, number>) => rate.input + rate.cacheRead + rate.cacheWrite;

/**
 * One row per account: rates, streams, quota and recent traffic. Rows in
 * the selected scope are highlighted; the table itself is not interactive.
 */
export function AccountsTable({ accounts, live, traffic, requests, units, span, seriesNames, inScope }: {
  accounts: Account[];
  live: LiveSnapshot | undefined;
  /** Per account, the chart's shown series per second over the range. */
  traffic: ActivityData | undefined;
  requests: RequestEntry[];
  units: Units;
  span: string;
  /** The chart's shown series, for the sparkline's description. */
  seriesNames: string[];
  inScope(accountId: string): boolean;
}) {
  const scheme = useColorScheme();
  // One scale for every row, so line heights compare across accounts.
  const peak = Math.max(1, ...Object.values(traffic?.accounts ?? {}).flat().map(v => v ?? 0));
  const format = units === "tokens" ? formatNumber : formatBytes;
  const series = seriesNames.length
    ? `Per second for each account, on one scale shared by every row: ${seriesNames.join(", ")}, as shown in the chart`
    : "No series is shown in the chart";
  return (
    <div className={ui.tableScroll}>
      <table id="dash-accounts" className={`${ui.dataTable} ${styles.accounts}`}>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" title={units === "tokens" ? "Input / output tokens per second" : "Uploaded / downloaded per second"}>
              {units === "tokens" ? "In / out per s" : "Up / down per s"}</th>
            <th scope="col">Streams</th>
            <th scope="col" title="Share of each quota window used. The mark shows how much of the window has passed.">Quota used</th>
            <th scope="col">Last request</th>
            <th scope="col" title={series}>{`${units === "tokens" ? "Tokens" : "Bytes"}/s · last ${span}`}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(a => {
            const s = live?.scopes[`account:${a.id}`];
            const last = requests.find(r => r.accountId === a.id);
            // Proxied responses update quota between overview refreshes.
            const recent = live?.quota?.[a.id];
            const values = traffic?.accounts[a.id] ?? [];
            const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0) * (traffic?.bucketMs ?? 0) / 1000;
            const detail = `${a.provider}${a.enabled ? "" : " · disabled"}`;
            return (
              <tr key={a.id} className={inScope(a.id) ? styles.inScope : undefined}>
                <td title={`${accountName(a)} · ${detail}`}>
                  <div className={styles.accountName}>{accountName(a)}</div>
                  <div className={styles.accountDetail}>{detail}</div>
                </td>
                <td>{units === "tokens"
                  ? (s ? `${formatNumber(sent(s.rate))} / ${formatNumber(s.rate.output)}` : "0 / 0")
                  : `${formatBytes(s?.rate.bytesUp ?? 0)} / ${formatBytes(s?.rate.bytesDown ?? 0)}`}</td>
                <td>{s ? String(s.active) : "0"}</td>
                <QuotaCell windows={recent ?? a.windows} at={recent ? live?.quotaAt?.[a.id] ?? NaN : Date.parse(a.quota?.observedAt ?? "")}
                  checking={!!live?.quotaChecking?.includes(a.id)} error={a.error ?? undefined} />
                <td>{last ? ago(last.startedAt) : "–"}</td>
                <td title={traffic ? `${accountName(a)}: ${format(total)}${units === "tokens" ? " tokens" : ""}, peak ${format(Math.max(0, ...values.map(v => v ?? 0)))}/s, in the last ${span} (${seriesNames.join(", ") || "no series shown"})` : ""}>
                  <Sparkline values={values} max={peak} scheme={scheme} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Sparkline({ values, max, scheme }: { values: (number | null)[]; max: number; scheme: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const draw = useRef(() => {});
  draw.current = () => sparkline(canvas.current!, values, cssVariable("--muted"), max);
  useEffect(() => { draw.current(); }, [values, max, scheme]);
  // A hidden tab has no size to draw at; draw again once it is shown.
  useEffect(() => {
    const observer = new ResizeObserver(() => draw.current());
    observer.observe(canvas.current!);
    return () => observer.disconnect();
  }, []);
  return <canvas ref={canvas} className={styles.sparkline} aria-hidden="true" />;
}

// One meter per window: label, used bar with a tick where usage would be on
// an even pace, and the rounded percent. A reading kept from before a
// restart, or not refreshed lately, is faded with its age until a probe
// lands; the age sits over the bars so the row never changes height.
export function QuotaCell({ windows, at, checking, error }: { windows: QuotaWindow[] | undefined; at: number; checking: boolean; error: string | undefined }) {
  const shown = (windows ?? []).filter(w => w.usedPercent != null);
  if (!shown.length) {
    return <td title={!checking && error ? error : ""}><div className={styles.quotaEmpty}>{checking ? "checking…" : error ? "check failed" : "not checked"}</div></td>;
  }
  const stale = !(Date.now() - at < QUOTA_STALE_MS);
  const note = checking ? "checking…" : stale ? (Number.isFinite(at) ? `as of ${ago(at)}` : "age unknown") : "";
  return (
    <td>
      <div className={styles.quotaCell}>
        <div className={`${styles.meters} ${stale ? styles.stale : ""}`}>
          {shown.map(w => <Meter key={w.bucket} window={w} />)}
        </div>
        <span className={styles.meterNote} hidden={!note}>{note}</span>
      </div>
    </td>
  );
}

function Meter({ window: w }: { window: QuotaWindow }) {
  const used = Math.min(100, w.usedPercent!);
  const pace = elapsedPercent(w);
  const title = [`${w.bucket}: ${tenth(used)}% used, ${tenth(Math.max(0, 100 - used))}% left`,
    w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "reset time unknown",
    ...(pace === null ? [] : [`mark: ${Math.round(pace)}% of the window has passed`])].join(" · ");
  return (
    <div className={styles.meter} data-bucket={w.bucket} data-level={used >= 95 ? "critical" : used >= 80 ? "warning" : ""} title={title}>
      <span className={styles.meterLabel}>{quotaLabel(w)}</span>
      <span className={styles.meterTrack}>
        <span className={styles.meterFill} style={{ width: `${used}%` }} />
        <span className={styles.meterPace} hidden={pace === null} style={pace === null ? undefined : { left: `${pace}%` }} />
      </span>
      <span className={styles.meterValue}>{`${Math.round(used)}%`}</span>
    </div>
  );
}
