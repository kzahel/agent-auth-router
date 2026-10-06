// Dashboard tab: live totals, a tiered traffic graph, per-account rows and
// recent requests. Everything here is provider-reported metadata; output
// marked "~" includes a live estimate the provider has not yet replaced.

import { TrafficGraph, formatBytes, formatNumber, sparkline } from "./graph.js";

const $ = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};

const RANGES = [["2m", "2 min"], ["10m", "10 min"], ["1h", "1 hour"], ["24h", "24 hours"], ["30d", "30 days"]];
const LIVE_RANGES = new Set(["2m", "10m", "1h"]);
// Fixed categorical order, validated for adjacency in light and dark modes.
const SERIES = {
  cacheRead: { label: "Cache read", slot: 1 },
  cacheWrite: { label: "Cache write", slot: 2 },
  input: { label: "Uncached input", slot: 3 },
  output: { label: "Output", slot: 4 },
  bytesUp: { label: "Uploaded", slot: 1 },
  bytesDown: { label: "Downloaded", slot: 4 },
};
const color = (slot) => getComputedStyle(document.documentElement).getPropertyValue(`--series-${slot}`).trim();
const sent = (rate) => rate.input + rate.cacheRead + rate.cacheWrite;

export function createDashboard({ client, overview }) {
  const graph = new TrafficGraph($("dash-graph"), $("dash-tooltip"));
  const quotaGraph = new TrafficGraph($("dash-quota-graph"), $("dash-quota-tooltip"));
  let range = localStorage.getItem("dash-range") ?? "2m";
  if (!RANGES.some(([key]) => key === range)) range = "2m";
  let scope = localStorage.getItem("dash-scope") ?? "all";
  let units = localStorage.getItem("dash-units") === "bytes" ? "bytes" : "tokens";
  let live, requests = [], visible = false, lastEvent = 0;
  const sparklines = new Map();
  const stop = [];

  const panes = () => units === "tokens"
    ? [
      { title: "Sent to model · tokens/s", series: ["cacheRead", "cacheWrite", "input"], stacked: true, direction: "up", format: formatNumber, unit: "/s" },
      { title: "Generated · tokens/s", series: ["output"], direction: "down", format: formatNumber, unit: "/s" },
    ]
    : [
      { title: "Uploaded · per second", series: ["bytesUp"], direction: "up", format: formatBytes, unit: "/s" },
      { title: "Downloaded · per second", series: ["bytesDown"], direction: "down", format: formatBytes, unit: "/s" },
    ];
  const configure = () => {
    graph.configure(panes().map(p => ({ ...p, series: p.series.map(key => ({ key, label: SERIES[key].label, color: color(SERIES[key].slot) })) })), { live: LIVE_RANGES.has(range) });
    renderLegend();
  };
  function renderLegend() {
    const legend = $("dash-legend");
    legend.replaceChildren();
    for (const pane of panes()) for (const key of pane.series) {
      const item = element("span", undefined, "legend-item");
      const swatch = element("span", undefined, "swatch");
      swatch.style.background = color(SERIES[key].slot);
      item.append(swatch, document.createTextNode(SERIES[key].label));
      legend.append(item);
    }
  }

  function subscribe() {
    for (const off of stop.splice(0)) off();
    if (!visible) return;
    configure();
    const metrics = units === "tokens" ? ["cacheRead", "cacheWrite", "input", "output"] : ["bytesUp", "bytesDown"];
    const history = { range, scope, metrics };
    stop.push(client.subscribe("history", history, (message) => {
      if (message.type === "error") return;
      lastEvent = Date.now();
      if (!graph.update(message)) { for (const off of stop.splice(0)) off(); subscribe(); return; }
      renderSummary();
    }));
    stop.push(client.subscribe("live", {}, (message) => {
      if (message.type === "error") return;
      lastEvent = Date.now();
      live = message.data;
      recordSparklines();
      renderLive();
    }));
    stop.push(client.subscribe("requests", {}, (message) => {
      if (message.type === "snapshot") requests = message.data.requests;
      else if (message.type === "request") {
        const index = requests.findIndex(r => r.id === message.data.id);
        if (index >= 0) requests[index] = message.data; else requests.unshift(message.data);
        requests = requests.slice(0, 50);
      }
      renderRequests();
    }));
    const quota = scope.startsWith("account:");
    $("dash-quota").hidden = !quota;
    if (quota) {
      quotaGraph.configure([], { live: LIVE_RANGES.has(range), rate: false });
      stop.push(client.subscribe("history", { range, scope, metrics: ["quota"] }, (message) => {
        if (message.type === "error") return;
        if (!quotaGraph.update(message)) { subscribe(); return; }
        const keys = Object.keys(quotaGraph.data.series).filter(k => k.startsWith("quota:")).sort();
        $("dash-quota-empty").hidden = keys.some(k => quotaGraph.data.series[k].some(v => v !== null));
        quotaGraph.configure([{ title: "Quota used · %", series: keys.slice(0, 4).map((key, i) => ({ key, label: key.slice(6).replaceAll("_", " "), color: color(i + 1) })),
          direction: "up", fill: false, maximum: 100, format: (v) => `${Math.round(v)}%`, unit: "" }], { live: LIVE_RANGES.has(range), rate: false });
      }));
    }
  }

  function accountLabel(id) {
    const a = overview()?.accounts.find(a => a.id === id);
    if (!a) return id;
    return a.nickname || (a.home ?? a.id).split("/").filter(Boolean).at(-1) || a.id;
  }
  function scopeRate(key) { return live?.scopes[key]; }

  function renderScopes() {
    const select = $("dash-scope"), snapshot = overview();
    const options = [["all", "All traffic"]];
    for (const p of snapshot?.pools ?? []) options.push([`pool:${p.id}`, `Pool · ${p.name}`]);
    for (const a of snapshot?.accounts ?? []) options.push([`account:${a.id}`, `Account · ${accountLabel(a.id)}`]);
    if (!options.some(([key]) => key === scope)) scope = "all";
    const current = [...select.options].map(o => `${o.value}=${o.textContent}`).join("|");
    if (current !== options.map(([k, l]) => `${k}=${l}`).join("|")) {
      select.replaceChildren(...options.map(([value, label]) => { const o = element("option", label); o.value = value; return o; }));
    }
    select.value = scope;
  }

  function renderLive() {
    const s = scopeRate(scope);
    const stats = [
      ["Active streams", s ? String(s.active) : "0"],
      ["Sent", s ? `${formatNumber(sent(s.rate))}/s` : "0/s"],
      ["Generated", s ? `${formatNumber(s.rate.output)}/s` : "0/s"],
      ["Cache hit · 1 min", s && sent(s.minute) ? `${Math.round((s.minute.cacheRead / sent(s.minute)) * 100)}%` : "–"],
      ["Requests · 1 min", s ? String(s.minute.requests) : "0"],
      ["Errors · 1 min", s ? String(s.minute.errors) : "0"],
    ];
    const tiles = $("dash-stats");
    if (tiles.children.length !== stats.length) {
      tiles.replaceChildren(...stats.map(([label]) => { const tile = element("div", undefined, "stat"); tile.append(element("span", label, "stat-label"), element("strong", "")); return tile; }));
    }
    stats.forEach(([, value], i) => { tiles.children[i].querySelector("strong").textContent = value; });
    renderAccounts();
    graph.stale = Date.now() - lastEvent > 3000;
  }

  function recordSparklines() {
    for (const [key, s] of Object.entries(live?.scopes ?? {})) {
      if (!key.startsWith("account:")) continue;
      const values = sparklines.get(key) ?? [];
      values.push(sent(s.rate) + s.rate.output);
      if (values.length > 120) values.shift();
      sparklines.set(key, values);
    }
  }

  function renderAccounts() {
    const body = $("dash-accounts").tBodies[0], snapshot = overview();
    const accounts = snapshot?.accounts ?? [];
    $("dash-accounts-empty").hidden = accounts.length > 0;
    $("dash-accounts").hidden = !accounts.length;
    const rows = new Map([...body.rows].map(r => [r.dataset.id, r]));
    const ordered = accounts.map(a => {
      let row = rows.get(a.id);
      if (!row) {
        row = element("tr");
        row.dataset.id = a.id;
        for (let i = 0; i < 6; i++) row.append(element("td"));
        const spark = element("canvas", undefined, "sparkline");
        spark.setAttribute("aria-hidden", "true");
        row.cells[5].append(spark);
        row.tabIndex = 0;
        row.title = "Show this account in the graph";
        const select = () => { scope = `account:${a.id}`; localStorage.setItem("dash-scope", scope); renderScopes(); subscribe(); };
        row.onclick = select;
        row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } };
      }
      const s = scopeRate(`account:${a.id}`);
      const last = requests.find(r => r.accountId === a.id);
      // Proxied responses update quota between overview refreshes.
      const quota = (live?.quota?.[a.id] ?? a.windows)?.filter(w => w.remainingPercent != null).map(w => `${w.bucket.replace(/^codex:/, "")} ${w.remainingPercent}%`).join(" · ");
      row.classList.toggle("selected", scope === `account:${a.id}`);
      row.cells[0].textContent = `${accountLabel(a.id)} · ${a.provider}${a.enabled ? "" : " · disabled"}`;
      row.cells[1].textContent = s ? `${formatNumber(sent(s.rate))} / ${formatNumber(s.rate.output)}` : "0 / 0";
      row.cells[2].textContent = s ? String(s.active) : "0";
      row.cells[3].textContent = quota ? `${quota} left` : "not checked";
      row.cells[4].textContent = last ? ago(last.startedAt) : "–";
      sparkline(row.cells[5].firstChild, sparklines.get(`account:${a.id}`) ?? [], color(1));
      return row;
    });
    if (ordered.some((row, i) => body.rows[i] !== row) || body.rows.length !== ordered.length) body.replaceChildren(...ordered);
  }

  function renderRequests() {
    const body = $("dash-requests").tBodies[0];
    $("dash-requests-empty").hidden = requests.length > 0;
    $("dash-requests").hidden = !requests.length;
    body.replaceChildren(...requests.slice(0, 25).map(r => {
      const row = element("tr");
      const input = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
      const cached = input ? Math.round((r.usage.cacheRead / input) * 100) : 0;
      const duration = ((r.endedAt ?? Date.now()) - r.startedAt) / 1000;
      const status = r.outcome === "active" ? "streaming" : r.outcome === "client_closed" ? "cancelled" : String(r.status ?? "");
      for (const text of [
        new Date(r.startedAt).toLocaleTimeString(),
        `${r.client} → ${accountLabel(r.accountId)}`,
        r.model ?? r.route,
        input ? `${formatNumber(input)} (${cached}% cached)` : "–",
        r.usage.output || r.outcome !== "active" ? `${r.estimated ? "~" : ""}${formatNumber(r.usage.output)}` : "–",
        `${duration.toFixed(duration < 10 ? 1 : 0)} s`,
        status,
      ]) row.append(element("td", text));
      if (r.outcome === "error") row.classList.add("error");
      return row;
    }));
  }

  function renderSummary() {
    const data = graph.data, body = $("dash-summary").tBodies[0];
    if (!data) return;
    const length = data.completeThrough - data.start + 1, perSecond = data.bucketMs / 1000;
    const format = units === "tokens" ? formatNumber : formatBytes;
    body.replaceChildren(...panes().flatMap(p => p.series).map(key => {
      const values = [];
      for (let i = 0; i < length; i++) { const v = data.series[key]?.[i]; if (v !== null && v !== undefined) values.push(v); }
      const total = values.reduce((a, b) => a + b, 0);
      const row = element("tr");
      const name = element("th"), label = element("span", undefined, "legend-item");
      const swatch = element("span", undefined, "swatch");
      swatch.style.background = color(SERIES[key].slot);
      label.append(swatch, document.createTextNode(SERIES[key].label));
      name.append(label);
      name.scope = "row";
      row.append(name);
      for (const value of [values.length ? values.at(-1) / perSecond : null, values.length ? total / values.length / perSecond : null, values.length ? Math.max(...values) / perSecond : null]) {
        row.append(element("td", value === null ? "–" : `${format(value)}/s`));
      }
      row.append(element("td", format(total)));
      return row;
    }));
  }

  // Controls.
  const rangeGroup = $("dash-range");
  rangeGroup.replaceChildren(...RANGES.map(([key, label]) => {
    const b = element("button", label);
    b.type = "button";
    b.dataset.range = key;
    b.setAttribute("aria-pressed", String(key === range));
    b.onclick = () => {
      range = key;
      localStorage.setItem("dash-range", range);
      for (const other of rangeGroup.children) other.setAttribute("aria-pressed", String(other.dataset.range === range));
      subscribe();
    };
    return b;
  }));
  for (const b of $("dash-units").children) {
    b.setAttribute("aria-pressed", String(b.dataset.units === units));
    b.onclick = () => {
      units = b.dataset.units;
      localStorage.setItem("dash-units", units);
      for (const other of $("dash-units").children) other.setAttribute("aria-pressed", String(other.dataset.units === units));
      subscribe();
    };
  }
  $("dash-scope").onchange = () => { scope = $("dash-scope").value; localStorage.setItem("dash-scope", scope); renderAccounts(); subscribe(); };
  $("dash-goto-accounts").onclick = () => document.getElementById("tab-accounts").click();
  setInterval(() => { if (visible) { graph.stale = Date.now() - lastEvent > 3000; if (requests.some(r => r.outcome === "active")) renderRequests(); } }, 1000);

  return {
    /** The tab subscribes only while it is shown. */
    show(shown) {
      if (visible === shown) return;
      visible = shown;
      graph.visible = shown;
      quotaGraph.visible = shown;
      renderScopes();
      subscribe();
      renderAccounts();
      renderRequests();
    },
    /** Overview changed: refresh labels and scope choices. */
    refresh() { renderScopes(); renderAccounts(); renderRequests(); },
    /** Reconnection repeats snapshots, so nothing else is needed here. */
  };
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
