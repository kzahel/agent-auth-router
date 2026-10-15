import { COST_ESTIMATED, ago, costTitle, formatCost, formatNumber } from "../lib/format.ts";
import type { RequestEntry, SessionSummary } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import styles from "./dashboard.module.css";

const COST_HEADER = "Estimated cost at the providers' published API prices; subscription accounts are not billed this";
const INPUT_HEADER = "Input tokens: cache reads, cache writes and uncached input";
const inputText = (usage: { input: number; cacheRead: number; cacheWrite: number }) => {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return input ? `${formatNumber(input)} (${Math.round((usage.cacheRead / input) * 100)}% cached)` : "–";
};

/** The latest 25 requests; output marked "~" includes a live estimate. */
export function RequestsTable({ requests, label }: { requests: RequestEntry[]; label(accountId: string): string }) {
  return (
    <div className={ui.tableScroll}>
      <table id="dash-requests" className={`${ui.dataTable} ${styles.requests}`} hidden={!requests.length}>
        <thead>
          <tr>
            <th scope="col">Time</th><th scope="col">Client → account</th><th scope="col">Model</th>
            <th scope="col" title={INPUT_HEADER}>Input</th><th scope="col">Output</th>
            <th scope="col" title={COST_HEADER}>Cost</th><th scope="col">Duration</th><th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {requests.slice(0, 25).map(r => {
            const duration = ((r.endedAt ?? Date.now()) - r.startedAt) / 1000;
            const route = `${r.client} → ${label(r.accountId)}`;
            const priced = r.cost !== null && r.cost !== undefined;
            return (
              <tr key={r.id} className={r.outcome === "error" ? styles.errorRow : undefined}>
                <td>{new Date(r.startedAt).toLocaleTimeString()}</td>
                <td title={route}>{route}</td>
                <td title={r.model ?? r.route}>{r.model ?? r.route}</td>
                <td>{inputText(r.usage)}</td>
                <td>{r.usage.output || r.outcome !== "active" ? `${r.estimated ? "~" : ""}${formatNumber(r.usage.output)}` : "–"}</td>
                <td title={r.outcome === "active" ? "Priced when the response ends" : !priced ? "No price for this model" : costTitle(!!(r.costFlags & COST_ESTIMATED), 0)}>
                  {priced ? `${r.costFlags & COST_ESTIMATED ? "~" : ""}${formatCost(r.cost!)}` : "–"}
                </td>
                <td>{`${duration.toFixed(duration < 10 ? 1 : 0)} s`}</td>
                <td>{r.outcome === "active" ? "streaming" : r.outcome === "client_closed" ? "cancelled" : String(r.status ?? "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The 25 most recently active sessions in the range, totalled by the router. */
export function SessionsTable({ sessions, streaming, label }: { sessions: SessionSummary[]; streaming: ReadonlySet<string>; label(accountId: string): string }) {
  return (
    <div className={ui.tableScroll}>
      <table id="dash-sessions" className={`${ui.dataTable} ${styles.sessions}`} hidden={!sessions.length}>
        <thead>
          <tr>
            <th scope="col">Session</th><th scope="col">Client → account</th><th scope="col">Model</th><th scope="col">Requests</th>
            <th scope="col" title={INPUT_HEADER}>Input</th><th scope="col">Output</th>
            <th scope="col" title={COST_HEADER}>Cost</th><th scope="col">Last active</th>
          </tr>
        </thead>
        <tbody>
          {sessions.slice(0, 25).map(s => {
            const active = streaming.has(s.sessionId);
            const route = `${s.client} → ${s.accountIds.map(label).join(", ")}`;
            // Idle past the provider's five-minute prompt cache.
            const idle = !active && Date.now() - s.lastAt > 5 * 60_000;
            return (
              <tr key={s.sessionId} className={idle ? styles.idle : undefined}>
                <td title={s.sessionId}>{s.sessionId.slice(0, 8)}</td>
                <td title={route}>{route}</td>
                <td title={s.model ?? ""}>{s.model ?? "–"}</td>
                <td className={s.errors ? ui.danger : undefined} title={`${s.requests} requests${s.errors ? `, ${s.errors} failed` : ""} since ${new Date(s.firstAt).toLocaleString()}`}>{String(s.requests)}</td>
                <td>{inputText(s.usage)}</td>
                <td>{`${s.estimated ? "~" : ""}${formatNumber(s.usage.output)}`}</td>
                <td title={costTitle(s.cost.estimated > 0, s.cost.unpriced)}>{s.cost.requests > s.cost.unpriced ? `${s.cost.estimated ? "~" : ""}${formatCost(s.cost.cost)}` : "–"}</td>
                <td>{active ? "streaming" : ago(s.lastAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
