// Dashboard tab: live totals, a tiered traffic graph, per-account rows and
// recent activity. Everything here is provider-reported metadata; output
// marked "~" includes a live estimate the provider has not yet replaced.
// The tab subscribes only while it is shown.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GraphMessage, TrafficGraph } from "../chart/traffic-graph.ts";
import { useApp, useRouterView } from "../app/context.tsx";
import { accountName } from "../lib/accounts.ts";
import { formatBytes, formatCost, formatNumber } from "../lib/format.ts";
import { quotaLabel } from "../lib/quota.ts";
import type { ActivityData, Counter, LiveSnapshot, Overview, RangeCost, RequestEntry, SessionSummary } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import { AccountsTable } from "./AccountsTable.tsx";
import { RequestsTable, SessionsTable } from "./ActivityTables.tsx";
import styles from "./dashboard.module.css";
import { cssVariable, useColorScheme, useTicker, useTrafficGraph } from "./hooks.ts";
import { LIVE_RANGES, RANGES, SERIES, isDefaultView, panes, rangeSpan, useView, type SeriesKey, type Units } from "./view.ts";

const sent = (rate: Record<Counter, number>) => rate.input + rate.cacheRead + rate.cacheWrite;
const seriesColor = (key: SeriesKey) => `var(--series-${SERIES[key].slot})`;

interface Stored { sessions: SessionSummary[] | undefined; stored: boolean; cost: RangeCost | undefined }

export function DashboardTab({ visible, onAddAccount }: { visible: boolean; onAddAccount(): void }) {
  const { client } = useApp();
  const { overview } = useRouterView();
  const [view, change, reset] = useView();
  const { range, units, activity } = view;
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const scopes = useMemo(() => scopeOptions(overview), [overview]);
  // A pool or account that no longer exists shows all traffic.
  const scope = !overview || scopes.some(([key]) => key === view.scope) ? view.scope : "all";
  const allSeries = panes(units).flatMap(p => p.series);
  const shown = allSeries.filter(key => !hidden.has(key));
  const span = rangeSpan(range);
  const scheme = useColorScheme();

  const main = useTrafficGraph(), quota = useTrafficGraph();
  const [live, setLive] = useState<LiveSnapshot>();
  const [requests, setRequests] = useState<RequestEntry[]>([]);
  const [traffic, setTraffic] = useState<ActivityData>();
  const [stored, setStored] = useState<Stored>({ sessions: undefined, stored: true, cost: undefined });
  const [quotaKeys, setQuotaKeys] = useState<string[]>([]);
  const [quotaSamples, setQuotaSamples] = useState(false);
  // Bumped when the graph's data changes, which the legend and values read.
  const [, setHistoryVersion] = useState(0);
  // Bumped to subscribe again when an append does not continue the data.
  const [restart, setRestart] = useState(0);
  const lastEvent = useRef(0);

  // Sessions and the range's cost are totalled by the router from stored
  // requests: fetched for the selected range and scope, and again shortly after
  // each request finishes, in either view so switching to Sessions is instant.
  const query = useRef({ range, scope, visible });
  query.current = { range, scope, visible };
  const storedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadStored = useCallback((delay = 1000) => {
    if (!query.current.visible) return;
    clearTimeout(storedTimer.current);
    storedTimer.current = setTimeout(async () => {
      const { range, scope } = query.current;
      try {
        const [result, cost] = await Promise.all([
          client.call<{ sessions: SessionSummary[]; stored: boolean }>("sessions/recent", { range, scope }),
          client.call<RangeCost>("history/cost", { range, scope }),
        ]);
        setStored({ sessions: result.sessions, stored: result.stored, cost });
      } catch { loadStored(3000); }
    }, delay);
  }, [client]);
  useEffect(() => () => clearTimeout(storedTimer.current), []);

  useEffect(() => {
    const graph = main.graph;
    if (!visible || !graph) return;
    // The previous range's cost would be wrong for the new one until it loads.
    setStored(current => ({ ...current, cost: undefined }));
    loadStored(0);
    const stops = [
      client.subscribe("history", { range, scope, metrics: panes(units).flatMap(p => p.series) }, (message) => {
        if (message.type === "error") return;
        lastEvent.current = Date.now();
        if (!graph.update(message as GraphMessage)) { setRestart(n => n + 1); return; }
        setHistoryVersion(n => n + 1);
      }),
      client.subscribe<LiveSnapshot>("live", {}, (message) => {
        if (message.type === "error") return;
        lastEvent.current = Date.now();
        graph.stale = false;
        // Snapshots repeat after a reconnect, such as a router restart.
        if (message.type === "snapshot") loadStored(0);
        setLive(message.data as LiveSnapshot);
      }),
      client.subscribe("requests", {}, (message) => {
        if (message.type === "snapshot") setRequests((message.data as { requests: RequestEntry[] }).requests);
        else if (message.type === "request") {
          const entry = message.data as RequestEntry;
          // As many as the router keeps, so a scoped view still has history.
          setRequests(current => {
            const index = current.findIndex(r => r.id === entry.id);
            return (index >= 0 ? current.with(index, entry) : [entry, ...current]).slice(0, 200);
          });
          if (entry.outcome !== "active") loadStored();
        }
      }),
    ];
    const quotaGraph = quota.graph;
    if (scope.startsWith("account:") && quotaGraph) {
      setQuotaKeys([]);
      stops.push(client.subscribe("history", { range, scope, metrics: ["quota"] }, (message) => {
        if (message.type === "error") return;
        if (!quotaGraph.update(message as GraphMessage)) { setRestart(n => n + 1); return; }
        const series = quotaGraph.data!.series;
        const keys = Object.keys(series).filter(k => k.startsWith("quota:")).sort();
        setQuotaSamples(keys.some(k => series[k]!.some(v => v !== null)));
        setQuotaKeys(current => current.join() === keys.join() ? current : keys);
      }));
    }
    return () => { for (const stop of stops) stop(); };
  }, [visible, main.graph, quota.graph, client, range, scope, units, restart, loadStored]);

  // Per account, the chart's shown series per second over the selected range,
  // from the router's history; subscribed again when the legend changes.
  const shownKey = shown.join();
  useEffect(() => {
    if (!visible) return;
    return client.subscribe<ActivityData>("activity", { range, metrics: shownKey ? shownKey.split(",") : [] }, (message) => {
      if (message.type !== "error") setTraffic(message.data as ActivityData);
    });
  }, [visible, client, range, shownKey, restart]);

  const shownPanes = panes(units).filter(p => p.series.some(key => !hidden.has(key)));
  useEffect(() => {
    main.graph?.configure((shownPanes.length ? shownPanes : panes(units).slice(0, 1)).map(p => ({ ...p,
      series: p.series.filter(key => !hidden.has(key)).map(key => ({ key, label: SERIES[key].label, color: cssVariable(`--series-${SERIES[key].slot}`), line: p.line?.includes(key) })),
      context: p.series.filter(key => hidden.has(key)).map(key => ({ key, label: SERIES[key].label })) })), { live: LIVE_RANGES.has(range) });
  }, [main.graph, units, hidden, range, scheme]);
  useEffect(() => {
    quota.graph?.configure(quotaKeys.length ? [{ title: "Quota used · %", maximum: 100, format: (v) => `${Math.round(v)}%`, unit: "",
      series: quotaKeys.slice(0, 4).map((key, i) => ({ key, label: quotaLabel({ bucket: key.slice(6) }), color: cssVariable(`--series-${i + 1}`) })) }] : [],
    { live: LIVE_RANGES.has(range), rate: false });
  }, [quota.graph, quotaKeys, range, scheme]);
  useEffect(() => {
    if (main.graph) main.graph.visible = visible;
    if (quota.graph) quota.graph.visible = visible;
    if (!visible) return;
    // Updates stopped arriving: the graph stops scrolling and says so.
    const timer = setInterval(() => { if (main.graph) main.graph.stale = Date.now() - lastEvent.current > 3000; }, 1000);
    return () => clearInterval(timer);
  }, [visible, main.graph, quota.graph]);
  // Running durations and ages tick while they are shown.
  useTicker(1000, visible && (activity === "sessions" || requests.some(r => r.outcome === "active")));

  const label = (id: string) => {
    const a = overview?.accounts.find(a => a.id === id);
    return a ? accountName(a) : id;
  };
  // The Show selector scopes the whole tab: tiles, graph, the highlighted
  // account rows and recent requests. A request carries its pool, if any;
  // an account row is in a pool's scope when the account is a member.
  const inScope = (accountId: string, poolId?: string | null) => {
    if (scope === `account:${accountId}`) return true;
    if (poolId !== undefined) return scope === `pool:${poolId}`;
    return !!overview?.pools.find(p => `pool:${p.id}` === scope)?.accountIds.includes(accountId);
  };
  const shownRequests = activity === "requests" ? requests.filter(r => scope === "all" || inScope(r.accountId, r.poolId ?? null)) : [];
  const streaming = new Set(requests.filter(r => r.outcome === "active" && r.sessionId).map(r => r.sessionId!));
  const totals = seriesTotals(main.graph, allSeries, units);
  const activityBody = useRef<HTMLDivElement>(null);
  const accounts = overview?.accounts ?? [];

  return (
    <>
      <div className={styles.controls}>
        <label className={styles.scope}><span className={ui.visuallyHidden}>Show</span>
          <select id="dash-scope" value={scope} onChange={(event) => change({ scope: event.target.value })}>
            {scopes.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <div className={ui.segmented} role="group" aria-label="Time range">
          {RANGES.map(([key, text]) => <button key={key} type="button" aria-pressed={key === range} onClick={() => change({ range: key })}>{text}</button>)}
        </div>
        <div className={ui.segmented} role="group" aria-label="Units">
          {(["tokens", "bytes"] as Units[]).map(key => <button key={key} type="button" aria-pressed={key === units} onClick={() => change({ units: key })}>{key === "tokens" ? "Tokens" : "Bytes"}</button>)}
        </div>
        {/* Disabled rather than hidden, so the controls row never shifts. */}
        <button type="button" className={styles.reset} disabled={isDefaultView({ ...view, scope })} onClick={reset}
          title="Back to 2 min, all traffic, tokens, the default series and requests">Reset view</button>
      </div>
      <StatTiles rates={live?.scopes[scope]} units={units} />
      <figure className={styles.chart} title="Per-second rates from complete buckets. While a response streams, its output is estimated at about four characters per token; the provider's count replaces the estimate when the response ends.">
        {/* Every series with its total for the selected range, which leads the legend
            so the totals are not read as running counts. Each entry switches its
            series on or off; the full values table sits collapsed under the chart. */}
        <div className={styles.legend}>
          <span className={styles.legendRange}>{`Last ${span}:`}</span>
          {allSeries.map(key => {
            const name = SERIES[key].label.toLowerCase();
            return (
              <button key={key} type="button" className={styles.legendItem} aria-pressed={!hidden.has(key)} style={{ "--swatch": seriesColor(key) } as CSSProperties}
                title={hidden.has(key) ? `Show ${name} in the chart` : `Hide ${name} from the chart`}
                onClick={() => change({ hidden: hidden.has(key) ? view.hidden.filter(k => k !== key) : [...view.hidden, key] })}>
                <span className={ui.swatch} />{SERIES[key].label}<b>{totals.get(key)?.legend ?? "–"}</b>
              </button>
            );
          })}
          <RangeCostNote cost={stored.cost} />
        </div>
        <div className={styles.frame}>
          <canvas ref={main.canvas} id="dash-graph" className={shownPanes.length <= 1 ? styles.singlePane : undefined} tabIndex={0} role="img"
            aria-label="Traffic over time. Use the arrow keys to read exact values; the Values table below lists every series." />
          <div ref={main.tooltip} className={styles.tooltip} role="status" hidden />
        </div>
      </figure>
      <details className={styles.chartValues}>
        <summary>Values</summary>
        <table id="dash-summary" className={ui.dataTable}>
          <caption className={ui.visuallyHidden}>Series values for the visible range</caption>
          <thead><tr><th scope="col">Series</th><th scope="col">Last</th><th scope="col">Average</th><th scope="col">Peak</th><th scope="col">Total</th></tr></thead>
          <tbody>
            {main.graph?.data && allSeries.map(key => {
              const t = totals.get(key)!;
              return (
                <tr key={key}>
                  <th scope="row"><span className={styles.legendItem}><span className={ui.swatch} style={{ background: seriesColor(key) }} />{SERIES[key].label}</span></th>
                  {[t.last, t.average, t.peak].map((value, i) => <td key={i}>{value === null ? "–" : `${t.format(value)}/s`}</td>)}
                  <td>{t.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
      <div id="dash-quota" className={styles.quota} hidden={!scope.startsWith("account:")}>
        <div className={`${styles.frame} ${styles.quotaFrame}`}>
          <canvas ref={quota.canvas} tabIndex={0} role="img" aria-label="Quota used over time" />
          <div ref={quota.tooltip} className={styles.tooltip} role="status" hidden />
        </div>
        <p id="dash-quota-empty" className={ui.hint} hidden={quotaSamples}>No quota samples in this range yet. Samples come from usage refreshes and proxied responses.</p>
      </div>
      <h2 className={styles.heading}>Accounts</h2>
      {accounts.length ? (
        <AccountsTable accounts={accounts} live={live} traffic={traffic} requests={requests} units={units} span={span}
          seriesNames={shown.map(key => SERIES[key].label.toLowerCase())} inScope={(id) => inScope(id)} />
      ) : (
        <p className={ui.hint}>No accounts yet. <button type="button" onClick={onAddAccount}>Add an account</button></p>
      )}
      <div className={`${ui.sectionHeading} ${styles.heading}`}>
        <h2>{activity === "sessions" ? "Recent sessions" : "Recent requests"}</h2>
        <div className={ui.segmented} role="group" aria-label="Recent activity">
          {(["requests", "sessions"] as const).map(key => (
            <button key={key} type="button" aria-pressed={key === activity} onClick={() => {
              // Hold the section's height so a shorter view does not pull the page up.
              const body = activityBody.current!;
              body.style.minHeight = `${Math.max(body.offsetHeight, parseFloat(body.style.minHeight) || 0)}px`;
              change({ activity: key });
              loadStored(0);
            }}>{key === "requests" ? "Requests" : "Sessions"}</button>
          ))}
        </div>
      </div>
      <div ref={activityBody}>
        <p className={ui.hint} hidden={activity !== "requests" || shownRequests.length > 0}>
          {scope === "all" ? "No requests since the router started." : "No recent requests in this scope."}
        </p>
        <p className={ui.hint} hidden={activity !== "sessions" || !!stored.sessions?.length}>
          {!stored.sessions ? "Loading sessions…" : stored.stored ? "No sessions in this range." : "Sessions need the router's history database, which could not be opened."}
        </p>
        {activity === "sessions" && stored.sessions && <SessionsTable sessions={stored.sessions} streaming={streaming} label={label} />}
        <RequestsTable requests={shownRequests} label={label} />
      </div>
    </>
  );
}

function scopeOptions(overview: Overview | undefined): [string, string][] {
  return [["all", "All traffic"],
    ...(overview?.pools ?? []).map(p => [`pool:${p.id}`, `Pool · ${p.name}`] as [string, string]),
    ...(overview?.accounts ?? []).map(a => [`account:${a.id}`, `Account · ${accountName(a)}`] as [string, string])];
}

/** Each series' last, average and peak rate and its total over the graph's range. */
function seriesTotals(graph: TrafficGraph | undefined, keys: SeriesKey[], units: Units) {
  const data = graph?.data;
  const format = units === "tokens" ? formatNumber : formatBytes;
  // Totals are whole counts; the rate formatter would print 6 as "6.0".
  const formatTotal = (value: number) => value < 10 ? String(Math.round(value)) : format(value);
  const result = new Map<SeriesKey, { last: number | null; average: number | null; peak: number | null; total: string; legend: string; format: (value: number) => string }>();
  if (!data) return result;
  const length = data.completeThrough - data.start + 1, perSecond = data.bucketMs / 1000;
  for (const key of keys) {
    const values: number[] = [];
    for (let i = 0; i < length; i++) { const v = data.series[key]?.[i]; if (v !== null && v !== undefined) values.push(v); }
    const total = values.reduce((a, b) => a + b, 0);
    result.set(key, {
      last: values.length ? values.at(-1)! / perSecond : null,
      average: values.length ? total / values.length / perSecond : null,
      peak: values.length ? Math.max(...values) / perSecond : null,
      total: formatTotal(total),
      legend: values.length ? formatTotal(total) : "–",
      format,
    });
  }
  return result;
}

function StatTiles({ rates: s, units }: { rates: LiveSnapshot["scopes"][string] | undefined; units: Units }) {
  const stats: [string, string][] = [
    // Every tile names its window. Rates average the last minute: a request
    // uploads its context in about a second, so a 5-second rate mostly read 0.
    // Sessions count conversations, however many requests each runs at once.
    ["Sessions · 1 min", s ? String(s.sessions ?? 0) : "0"],
    // The two traffic tiles follow Tokens/Bytes; cache hit is a token measure either way.
    ...(units === "tokens" ? [
      ["Input · 1 min", s ? `${formatNumber(sent(s.minute) / 60)}/s` : "0/s"],
      ["Output · 1 min", s ? `${formatNumber(s.minute.output / 60)}/s` : "0/s"],
    ] as [string, string][] : [
      ["Uploaded · 1 min", `${formatBytes(s ? s.minute.bytesUp / 60 : 0)}/s`],
      ["Downloaded · 1 min", `${formatBytes(s ? s.minute.bytesDown / 60 : 0)}/s`],
    ] as [string, string][]),
    ["Cache hit · 1 min", s && sent(s.minute) ? `${Math.round((s.minute.cacheRead / sent(s.minute)) * 100)}%` : "–"],
    ["Requests · 1 min", s ? String(s.minute.requests) : "0"],
    ["Errors · 1 min", s ? String(s.minute.errors) : "0"],
  ];
  return (
    <div id="dash-stats" className={styles.stats} aria-live="off">
      {stats.map(([label, value], i) => <div key={i} className={styles.stat}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
  );
}

/** Legend total: what the selected range's traffic would cost at API list prices. */
function RangeCostNote({ cost }: { cost: RangeCost | undefined }) {
  const summary = cost?.summary;
  return (
    <span className={styles.legendCost} hidden={!summary?.requests} title={summary && cost ? [
      `Estimated cost of these ${summary.requests} requests at the providers' published API prices (genai-prices ${cost.prices.date}).`,
      "Subscription accounts are not billed these amounts.",
      ...(summary.estimated ? [`${summary.estimated} partly estimated: cache writes recorded before the router noted their duration (priced as 1-hour), or output never reported.`] : []),
      ...(summary.unpriced ? [`${summary.unpriced} unpriced: no price for their model.`] : [])].join(" ") : undefined}>
      {summary ? `${summary.estimated ? "≈ " : ""}${formatCost(summary.cost)} at API rates` : ""}
    </span>
  );
}
