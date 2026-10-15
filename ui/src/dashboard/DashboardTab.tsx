// The Dashboard tab, still rendered imperatively by legacy-dashboard.ts into
// this markup; it subscribes only while the tab is shown.

import { useEffect, useRef } from "react";
import { useApp, useRouterView } from "../app/context.tsx";
import { createDashboard } from "./legacy-dashboard.ts";
import "./legacy.css";

export function DashboardTab({ visible, onAddAccount }: { visible: boolean; onAddAccount(): void }) {
  const { client } = useApp();
  const { overview } = useRouterView();
  const latest = useRef(overview);
  latest.current = overview;
  const dashboard = useRef<ReturnType<typeof createDashboard>>(undefined);
  useEffect(() => { dashboard.current ??= createDashboard({ client, overview: () => latest.current }); }, [client]);
  useEffect(() => { dashboard.current?.refresh(); }, [overview]);
  useEffect(() => { dashboard.current?.show(visible); }, [visible]);
  return (
    <>
      <div className="dash-controls">
        <label className="dash-scope"><span className="visually-hidden">Show</span><select id="dash-scope"><option value="all">All traffic</option></select></label>
        <div id="dash-range" className="segmented" role="group" aria-label="Time range"></div>
        <div id="dash-units" className="segmented" role="group" aria-label="Units"><button type="button" data-units="tokens">Tokens</button><button type="button" data-units="bytes">Bytes</button></div>
        <button type="button" id="dash-reset" title="Back to 2 min, all traffic, tokens, the default series and requests">Reset view</button>
      </div>
      <div id="dash-stats" className="stats" aria-live="off"></div>
      <figure className="chart" title="Per-second rates from complete buckets. While a response streams, its output is estimated at about four characters per token; the provider's count replaces the estimate when the response ends.">
        <div id="dash-legend" className="legend"></div>
        <div className="chart-frame"><canvas id="dash-graph" tabIndex={0} role="img" aria-label="Traffic over time. Use the arrow keys to read exact values; the Values table below lists every series."></canvas><div id="dash-tooltip" className="chart-tooltip" role="status" hidden></div></div>
      </figure>
      <details className="chart-values"><summary>Values</summary><table id="dash-summary" className="data-table"><caption className="visually-hidden">Series values for the visible range</caption><thead><tr><th scope="col">Series</th><th scope="col">Last</th><th scope="col">Average</th><th scope="col">Peak</th><th scope="col">Total</th></tr></thead><tbody></tbody></table></details>
      <div id="dash-quota" hidden><div className="chart-frame quota-frame"><canvas id="dash-quota-graph" tabIndex={0} role="img" aria-label="Quota used over time"></canvas><div id="dash-quota-tooltip" className="chart-tooltip" role="status" hidden></div></div><p id="dash-quota-empty" className="hint">No quota samples in this range yet. Samples come from usage refreshes and proxied responses.</p></div>
      <h2 className="dash-heading">Accounts</h2>
      <p id="dash-accounts-empty" className="hint">No accounts yet. <button type="button" id="dash-goto-accounts" onClick={onAddAccount}>Add an account</button></p>
      <table id="dash-accounts" className="data-table" hidden><thead><tr><th scope="col">Account</th><th scope="col" id="dash-rate-head">Input / output per s</th><th scope="col">Streams</th><th scope="col" title="Share of each quota window used. The mark shows how much of the window has passed.">Quota used</th><th scope="col">Last request</th><th scope="col" id="dash-spark-head" title="Input and output tokens per second for each account, from the router's history for the selected range, on one scale shared by every row">Tokens/s · last 2 min</th></tr></thead><tbody></tbody></table>
      <div className="section-heading dash-heading"><h2 id="dash-activity-title">Recent requests</h2><div id="dash-activity" className="segmented" role="group" aria-label="Recent activity"><button type="button" data-view="requests">Requests</button><button type="button" data-view="sessions">Sessions</button></div></div>
      <div id="dash-activity-body">
        <p id="dash-requests-empty" className="hint">No requests since the router started.</p>
        <p id="dash-sessions-empty" className="hint" hidden>No sessions in this range.</p>
        <div className="table-scroll"><table id="dash-sessions" className="data-table" hidden><thead><tr><th scope="col">Session</th><th scope="col">Client → account</th><th scope="col">Model</th><th scope="col">Requests</th><th scope="col" title="Input tokens: cache reads, cache writes and uncached input">Input</th><th scope="col">Output</th><th scope="col" title="Estimated cost at the providers' published API prices; subscription accounts are not billed this">Cost</th><th scope="col">Last active</th></tr></thead><tbody></tbody></table></div>
        <div className="table-scroll"><table id="dash-requests" className="data-table" hidden><thead><tr><th scope="col">Time</th><th scope="col">Client → account</th><th scope="col">Model</th><th scope="col" title="Input tokens: cache reads, cache writes and uncached input">Input</th><th scope="col">Output</th><th scope="col" title="Estimated cost at the providers' published API prices; subscription accounts are not billed this">Cost</th><th scope="col">Duration</th><th scope="col">Status</th></tr></thead><tbody></tbody></table></div>
      </div>
    </>
  );
}
