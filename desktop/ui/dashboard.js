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
// Output is drawn over the input bands, so the three token series take the
// palette's first three slots, which validate as distinct in every pairing in
// both modes. Cache read is background volume, off by default, in a neutral.
const SERIES = {
  cacheRead: { label: "Cache read", slot: "neutral" },
  cacheWrite: { label: "Cache write", slot: 2 },
  input: { label: "Uncached input", slot: 3 },
  output: { label: "Output", slot: 1 },
  bytesUp: { label: "Uploaded", slot: 1 },
  // What the router sent on: smaller than Uploaded when it compresses requests.
  bytesSent: { label: "Sent upstream", slot: 2 },
  bytesDown: { label: "Downloaded", slot: 4 },
};
// The view a new browser starts with, and what Reset view returns to.
const DEFAULT_VIEW = { range: "2m", scope: "all", units: "tokens", activity: "requests", hidden: ["cacheRead"] };
const VIEW_KEYS = ["dash-range", "dash-scope", "dash-units", "dash-activity", "dash-hidden"];
const color = (slot) => getComputedStyle(document.documentElement).getPropertyValue(`--series-${slot}`).trim();
const sent = (rate) => rate.input + rate.cacheRead + rate.cacheWrite;

export function createDashboard({ client, overview }) {
  const graph = new TrafficGraph($("dash-graph"), $("dash-tooltip"));
  const quotaGraph = new TrafficGraph($("dash-quota-graph"), $("dash-quota-tooltip"));
  let range = localStorage.getItem("dash-range") ?? DEFAULT_VIEW.range;
  if (!RANGES.some(([key]) => key === range)) range = DEFAULT_VIEW.range;
  let scope = localStorage.getItem("dash-scope") ?? DEFAULT_VIEW.scope;
  let units = localStorage.getItem("dash-units") === "bytes" ? "bytes" : DEFAULT_VIEW.units;
  let activity = localStorage.getItem("dash-activity") === "sessions" ? "sessions" : DEFAULT_VIEW.activity;
  // Series switched off in the legend. Cache reads start off: nearly all of what
  // is sent and cheap, they would flatten the costlier tokens to a hairline.
  let hidden;
  try { hidden = new Set(JSON.parse(localStorage.getItem("dash-hidden") ?? JSON.stringify(DEFAULT_VIEW.hidden))); } catch { hidden = new Set(DEFAULT_VIEW.hidden); }
  const isDefaultView = () => range === DEFAULT_VIEW.range && scope === DEFAULT_VIEW.scope && units === DEFAULT_VIEW.units
    && activity === DEFAULT_VIEW.activity && [...hidden].sort().join() === [...DEFAULT_VIEW.hidden].sort().join();
  let live, requests = [], visible = false, lastEvent = 0;
  let sessions, sessionsStored = true, sessionsTimer, rangeCost;
  // Per account, the chart's shown series per second over the selected range,
  // from the router's history; resubscribed when the legend changes.
  let accountTraffic, stopActivity;
  const shownSeries = () => panes().flatMap(p => p.series).filter(key => !hidden.has(key));
  function subscribeActivity() {
    stopActivity?.();
    stopActivity = visible ? client.subscribe("activity", { range, metrics: shownSeries() }, (message) => {
      if (message.type === "error") return;
      accountTraffic = message.data;
      renderAccounts();
    }) : undefined;
  }
  const stop = [];

  // Tokens share one axis: new input and output are of similar size. Bytes keep
  // two panes, since uploads (whole contexts) dwarf downloads.
  const panes = () => units === "tokens"
    ? [{ title: "Tokens per second", series: ["cacheRead", "cacheWrite", "input", "output"], line: ["output"], stacked: true, format: formatNumber, unit: "/s" }]
    : [
      { title: "Uploaded · per second", series: ["bytesUp", "bytesSent"], format: formatBytes, unit: "/s" },
      { title: "Downloaded · per second", series: ["bytesDown"], format: formatBytes, unit: "/s" },
    ];
  const configure = () => {
    const shown = panes().filter(p => p.series.some(key => !hidden.has(key)));
    $("dash-graph").classList.toggle("single-pane", shown.length <= 1);
    // Disabled rather than hidden, so the controls row never shifts.
    $("dash-reset").disabled = isDefaultView();
    graph.configure((shown.length ? shown : panes().slice(0, 1)).map(p => ({ ...p,
      series: p.series.filter(key => !hidden.has(key)).map(key => ({ key, label: SERIES[key].label, color: color(SERIES[key].slot), line: p.line?.includes(key) })),
      context: p.series.filter(key => hidden.has(key)).map(key => ({ key, label: SERIES[key].label })) })), { live: LIVE_RANGES.has(range) });
    renderLegend();
  };
  const rangeSpan = () => RANGES.find(([key]) => key === range)[1].replace(/^1 /, "");
  // Every series with its total for the selected range, which leads the legend
  // so the totals are not read as running counts. Each entry switches its series
  // on or off; the full values table sits collapsed under the chart.
  function renderLegend() {
    const span = rangeSpan();
    const series = shownSeries().map(key => SERIES[key].label.toLowerCase());
    $("dash-spark-head").textContent = `${units === "tokens" ? "Tokens" : "Bytes"}/s · last ${span}`;
    $("dash-rate-head").textContent = units === "tokens" ? "Input / output per s" : "Uploaded / downloaded per s";
    $("dash-spark-head").title = series.length
      ? `Per second for each account, on one scale shared by every row: ${series.join(", ")}, as shown in the chart`
      : "No series is shown in the chart";
    $("dash-legend").replaceChildren(element("span", `Last ${span}:`, "legend-range"), ...panes().flatMap(p => p.series).map(key => {
      const item = element("button", undefined, "legend-item");
      item.type = "button";
      item.dataset.key = key;
      item.setAttribute("aria-pressed", String(!hidden.has(key)));
      item.title = hidden.has(key) ? `Show ${SERIES[key].label.toLowerCase()} in the chart` : `Hide ${SERIES[key].label.toLowerCase()} from the chart`;
      const swatch = element("span", undefined, "swatch");
      swatch.style.setProperty("--swatch", color(SERIES[key].slot));
      item.append(swatch, document.createTextNode(SERIES[key].label), element("b", "–"));
      item.onclick = () => {
        if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
        localStorage.setItem("dash-hidden", JSON.stringify([...hidden]));
        configure();
        subscribeActivity();
        renderSummary();
      };
      return item;
    }), element("span", undefined, "legend-cost"));
    renderCost();
  }

  function subscribe() {
    for (const off of stop.splice(0)) off();
    stopActivity?.();
    stopActivity = undefined;
    if (!visible) return;
    // The previous range's cost would be wrong for the new one until it loads.
    rangeCost = undefined;
    configure();
    loadStored(0);
    const metrics = panes().flatMap(p => p.series);
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
      // Snapshots repeat after a reconnect, such as a router restart.
      if (message.type === "snapshot") loadStored(0);
      live = message.data;
      renderLive();
    }));
    subscribeActivity();
    stop.push(client.subscribe("requests", {}, (message) => {
      if (message.type === "snapshot") requests = message.data.requests;
      else if (message.type === "request") {
        const index = requests.findIndex(r => r.id === message.data.id);
        if (index >= 0) requests[index] = message.data; else requests.unshift(message.data);
        // As many as the router keeps, so a scoped view still has history.
        requests = requests.slice(0, 200);
        if (message.data.outcome !== "active") loadStored();
      }
      renderRequests();
      renderSessions();
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
        quotaGraph.configure([{ title: "Quota used · %", series: keys.slice(0, 4).map((key, i) => ({ key, label: quotaLabel({ bucket: key.slice(6) }), color: color(i + 1) })),
          maximum: 100, format: (v) => `${Math.round(v)}%`, unit: "" }], { live: LIVE_RANGES.has(range), rate: false });
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
      // Every tile names its window. Rates average the last minute: a request
      // uploads its context in about a second, so a 5-second rate mostly read 0.
      // Sessions count conversations, however many requests each runs at once.
      ["Sessions · 1 min", s ? String(s.sessions ?? 0) : "0"],
      // The two traffic tiles follow Tokens/Bytes; cache hit is a token measure either way.
      ...(units === "tokens" ? [
        ["Input · 1 min", s ? `${formatNumber(sent(s.minute) / 60)}/s` : "0/s"],
        ["Output · 1 min", s ? `${formatNumber(s.minute.output / 60)}/s` : "0/s"],
      ] : [
        ["Uploaded · 1 min", `${formatBytes(s ? s.minute.bytesUp / 60 : 0)}/s`],
        ["Downloaded · 1 min", `${formatBytes(s ? s.minute.bytesDown / 60 : 0)}/s`],
      ]),
      ["Cache hit · 1 min", s && sent(s.minute) ? `${Math.round((s.minute.cacheRead / sent(s.minute)) * 100)}%` : "–"],
      ["Requests · 1 min", s ? String(s.minute.requests) : "0"],
      ["Errors · 1 min", s ? String(s.minute.errors) : "0"],
    ];
    const tiles = $("dash-stats");
    if (tiles.children.length !== stats.length) {
      tiles.replaceChildren(...stats.map(([label]) => { const tile = element("div", undefined, "stat"); tile.append(element("span", label, "stat-label"), element("strong", "")); return tile; }));
    }
    stats.forEach(([label, value], i) => {
      tiles.children[i].querySelector(".stat-label").textContent = label;
      tiles.children[i].querySelector("strong").textContent = value;
    });
    renderAccounts();
    graph.stale = Date.now() - lastEvent > 3000;
  }

  function renderAccounts() {
    const body = $("dash-accounts").tBodies[0], snapshot = overview();
    const accounts = snapshot?.accounts ?? [];
    $("dash-accounts-empty").hidden = accounts.length > 0;
    $("dash-accounts").hidden = !accounts.length;
    const rows = new Map([...body.rows].map(r => [r.dataset.id, r]));
    const trafficPeak = Math.max(1, ...Object.values(accountTraffic?.accounts ?? {}).flat().map(v => v ?? 0));
    const ordered = accounts.map(a => {
      let row = rows.get(a.id);
      if (!row) {
        row = element("tr");
        row.dataset.id = a.id;
        for (let i = 0; i < 6; i++) row.append(element("td"));
        const spark = element("canvas", undefined, "sparkline");
        spark.setAttribute("aria-hidden", "true");
        row.cells[5].append(spark);
      }
      const s = scopeRate(`account:${a.id}`);
      const last = requests.find(r => r.accountId === a.id);
      // Proxied responses update quota between overview refreshes.
      row.classList.toggle("in-scope", inScope(a.id));
      row.cells[0].textContent = `${accountLabel(a.id)} · ${a.provider}${a.enabled ? "" : " · disabled"}`;
      row.cells[1].textContent = units === "tokens"
        ? (s ? `${formatNumber(sent(s.rate))} / ${formatNumber(s.rate.output)}` : "0 / 0")
        : `${formatBytes(s?.rate.bytesUp ?? 0)} / ${formatBytes(s?.rate.bytesDown ?? 0)}`;
      row.cells[2].textContent = s ? String(s.active) : "0";
      const recent = live?.quota?.[a.id];
      renderQuota(row.cells[3], recent ?? a.windows, { at: recent ? live.quotaAt?.[a.id] : Date.parse(a.quota?.observedAt ?? ""),
        checking: live?.quotaChecking?.includes(a.id), error: a.error });
      row.cells[4].textContent = last ? ago(last.startedAt) : "–";
      // One scale for every row, so line heights compare across accounts.
      const values = accountTraffic?.accounts[a.id] ?? [];
      const total = values.reduce((sum, v) => sum + (v ?? 0), 0) * (accountTraffic?.bucketMs ?? 0) / 1000;
      sparkline(row.cells[5].firstChild, values, getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(), trafficPeak);
      const format = units === "tokens" ? formatNumber : formatBytes, unit = units === "tokens" ? " tokens" : "";
      row.cells[5].title = accountTraffic ? `${accountLabel(a.id)}: ${format(total)}${unit}, peak ${format(Math.max(0, ...values.map(v => v ?? 0)))}/s, in the last ${rangeSpan()} (${shownSeries().map(key => SERIES[key].label.toLowerCase()).join(", ") || "no series shown"})` : "";
      return row;
    });
    if (ordered.some((row, i) => body.rows[i] !== row) || body.rows.length !== ordered.length) body.replaceChildren(...ordered);
  }

  // The Show selector scopes the whole tab: tiles, graph, the highlighted
  // account rows and recent requests. A request carries its pool, if any;
  // an account row is in a pool's scope when the account is a member.
  function inScope(accountId, poolId) {
    if (scope === `account:${accountId}`) return true;
    if (poolId !== undefined) return scope === `pool:${poolId}`;
    return !!overview()?.pools.find(p => `pool:${p.id}` === scope)?.accountIds.includes(accountId);
  }

  function renderActivity() {
    $("dash-reset").disabled = isDefaultView();
    $("dash-activity-title").textContent = activity === "sessions" ? "Recent sessions" : "Recent requests";
    for (const button of $("dash-activity").children) button.setAttribute("aria-pressed", String(button.dataset.view === activity));
    renderRequests();
    renderSessions();
  }

  // Sessions and the range's cost are totalled by the router from stored
  // requests: fetched for the selected range and scope, and again shortly after
  // each request finishes, in either view so switching to Sessions is instant.
  function loadStored(delay = 1000) {
    if (!visible) return;
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(async () => {
      try {
        const [result, cost] = await Promise.all([client.call("sessions/recent", { range, scope }), client.call("history/cost", { range, scope })]);
        sessions = result.sessions;
        sessionsStored = result.stored;
        rangeCost = cost;
        renderSessions();
        renderCost();
      } catch { loadStored(3000); }
    }, delay);
  }

  // Legend total: what the selected range's traffic would cost at API list prices.
  function renderCost() {
    const target = $("dash-legend").querySelector(".legend-cost");
    if (!target) return;
    const summary = rangeCost?.summary;
    target.hidden = !summary || !summary.requests;
    if (!summary) return;
    target.textContent = `${summary.estimated ? "≈ " : ""}${formatCost(summary.cost)} at API rates`;
    target.title = [`Estimated cost of these ${summary.requests} requests at the providers' published API prices (genai-prices ${rangeCost.prices.date}).`,
      "Subscription accounts are not billed these amounts.",
      ...(summary.estimated ? [`${summary.estimated} partly estimated: cache writes recorded before the router noted their duration (priced as 1-hour), or output never reported.`] : []),
      ...(summary.unpriced ? [`${summary.unpriced} unpriced: no price for their model.`] : [])].join(" ");
  }

  function renderSessions() {
    const shown = activity === "sessions";
    $("dash-sessions-empty").textContent = !sessions ? "Loading sessions…" : sessionsStored ? "No sessions in this range." : "Sessions need the router's history database, which could not be opened.";
    $("dash-sessions-empty").hidden = !shown || sessions?.length > 0;
    $("dash-sessions").hidden = !shown || !sessions?.length;
    if (!shown || !sessions) return;
    const streaming = new Set(requests.filter(r => r.outcome === "active" && r.sessionId).map(r => r.sessionId));
    $("dash-sessions").tBodies[0].replaceChildren(...sessions.slice(0, 25).map(s => {
      const row = element("tr");
      const input = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
      const cached = input ? Math.round((s.usage.cacheRead / input) * 100) : 0;
      const active = streaming.has(s.sessionId);
      for (const text of [
        s.sessionId.slice(0, 8),
        `${s.client} → ${s.accountIds.map(accountLabel).join(", ")}`,
        s.model ?? "–",
        String(s.requests),
        input ? `${formatNumber(input)} (${cached}% cached)` : "–",
        `${s.estimated ? "~" : ""}${formatNumber(s.usage.output)}`,
        s.cost.requests > s.cost.unpriced ? `${s.cost.estimated ? "~" : ""}${formatCost(s.cost.cost)}` : "–",
        active ? "streaming" : ago(s.lastAt),
      ]) row.append(element("td", text));
      row.cells[0].title = s.sessionId;
      row.cells[1].title = row.cells[1].textContent;
      row.cells[2].title = s.model ?? "";
      row.cells[3].title = `${s.requests} requests${s.errors ? `, ${s.errors} failed` : ""} since ${new Date(s.firstAt).toLocaleString()}`;
      row.cells[6].title = costTitle(s.cost.estimated > 0, s.cost.unpriced);
      if (s.errors) row.cells[3].classList.add("danger");
      // Idle past the provider's five-minute prompt cache.
      row.classList.toggle("idle", !active && Date.now() - s.lastAt > 5 * 60_000);
      return row;
    }));
  }

  function renderRequests() {
    const body = $("dash-requests").tBodies[0];
    const shown = activity === "requests" ? requests.filter(r => scope === "all" || inScope(r.accountId, r.poolId ?? null)) : [];
    $("dash-requests-empty").textContent = scope === "all" ? "No requests since the router started." : "No recent requests in this scope.";
    $("dash-requests-empty").hidden = activity !== "requests" || shown.length > 0;
    $("dash-requests").hidden = !shown.length;
    body.replaceChildren(...shown.slice(0, 25).map(r => {
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
        r.cost === null || r.cost === undefined ? "–" : `${r.costFlags & COST_ESTIMATED ? "~" : ""}${formatCost(r.cost)}`,
        `${duration.toFixed(duration < 10 ? 1 : 0)} s`,
        status,
      ]) row.append(element("td", text));
      row.cells[1].title = row.cells[1].textContent;
      row.cells[2].title = r.model ?? r.route;
      row.cells[5].title = r.outcome === "active" ? "Priced when the response ends" : r.cost === null || r.cost === undefined ? "No price for this model" : costTitle(r.costFlags & COST_ESTIMATED, 0);
      if (r.outcome === "error") row.classList.add("error");
      return row;
    }));
  }

  function renderSummary() {
    const data = graph.data, body = $("dash-summary").tBodies[0];
    if (!data) return;
    const length = data.completeThrough - data.start + 1, perSecond = data.bucketMs / 1000;
    const format = units === "tokens" ? formatNumber : formatBytes;
    // Totals are whole counts; the rate formatter would print 6 as "6.0".
    const formatTotal = (value) => value < 10 ? String(Math.round(value)) : format(value);
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
      row.append(element("td", formatTotal(total)));
      const legendTotal = $("dash-legend").querySelector(`[data-key="${key}"] b`);
      if (legendTotal) legendTotal.textContent = values.length ? formatTotal(total) : "–";
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
  $("dash-reset").onclick = () => {
    for (const key of VIEW_KEYS) localStorage.removeItem(key);
    ({ range, scope, units, activity } = DEFAULT_VIEW);
    hidden = new Set(DEFAULT_VIEW.hidden);
    for (const b of rangeGroup.children) b.setAttribute("aria-pressed", String(b.dataset.range === range));
    for (const b of $("dash-units").children) b.setAttribute("aria-pressed", String(b.dataset.units === units));
    renderScopes();
    renderAccounts();
    renderActivity();
    subscribe();
  };
  $("dash-scope").onchange = () => { scope = $("dash-scope").value; localStorage.setItem("dash-scope", scope); renderAccounts(); renderRequests(); subscribe(); };
  for (const button of $("dash-activity").children) {
    button.onclick = () => {
      // Hold the section's height so a shorter view does not pull the page up.
      const body = $("dash-activity-body");
      body.style.minHeight = `${Math.max(body.offsetHeight, parseFloat(body.style.minHeight) || 0)}px`;
      activity = button.dataset.view;
      localStorage.setItem("dash-activity", activity);
      renderActivity();
      loadStored(0);
    };
  }
  renderActivity();
  $("dash-goto-accounts").onclick = () => document.getElementById("tab-accounts").click();
  setInterval(() => { if (visible) { graph.stale = Date.now() - lastEvent > 3000; if (requests.some(r => r.outcome === "active")) renderRequests(); if (activity === "sessions") renderSessions(); } }, 1000);

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
      renderActivity();
    },
    /** Overview changed: refresh labels and scope choices. */
    refresh() { renderScopes(); renderAccounts(); renderRequests(); renderSessions(); },
    /** Reconnection repeats snapshots, so nothing else is needed here. */
  };
}

// Matches the router's DISPLAY_QUOTA_STALE_MS: an open dashboard has it
// reprobe readings this old, so older ones are drawn as last known.
const QUOTA_STALE_MS = 15 * 60_000;

// One meter per window: label, used bar with a tick where usage would be on
// an even pace, and the rounded percent. Elements are reused so values glide
// instead of the row reflowing on every update. A reading kept from before a
// restart, or not refreshed lately, is faded with its age until a probe lands;
// the age sits over the bars so the row never changes height.
function renderQuota(cell, windows, { at, checking, error }) {
  const shown = (windows ?? []).filter(w => w.usedPercent != null);
  if (!shown.length) {
    const text = checking ? "checking…" : error ? "check failed" : "not checked";
    if (cell.textContent !== text || !cell.firstElementChild?.classList.contains("quota-empty")) cell.replaceChildren(element("div", text, "quota-empty"));
    cell.title = !checking && error ? error : "";
    return;
  }
  let wrapper = cell.firstElementChild;
  if (!wrapper?.classList.contains("quota-cell")) {
    wrapper = element("div", undefined, "quota-cell");
    wrapper.append(element("div", undefined, "meters"), element("span", undefined, "meter-note"));
    cell.replaceChildren(wrapper);
    cell.title = "";
  }
  const [list, noteElement] = wrapper.children;
  const existing = new Map([...list.children].map(m => [m.dataset.bucket, m]));
  if ([...existing.keys()].join() !== shown.map(w => w.bucket).join()) list.replaceChildren(...shown.map(w => existing.get(w.bucket) ?? meter(w.bucket)));
  shown.forEach((w, i) => updateMeter(list.children[i], w));
  const stale = !(Date.now() - at < QUOTA_STALE_MS);
  list.classList.toggle("stale", stale);
  const note = checking ? "checking…" : stale ? (Number.isFinite(at) ? `as of ${ago(at)}` : "age unknown") : "";
  noteElement.textContent = note;
  noteElement.hidden = !note;
}

function meter(bucket) {
  const row = element("div", undefined, "meter");
  row.dataset.bucket = bucket;
  const track = element("span", undefined, "meter-track");
  track.append(element("span", undefined, "meter-fill"), element("span", undefined, "meter-pace"));
  row.append(element("span", undefined, "meter-label"), track, element("span", undefined, "meter-value"));
  return row;
}

function updateMeter(row, w) {
  const used = Math.min(100, w.usedPercent);
  const [label, track, value] = row.children;
  const [fill, tick] = track.children;
  label.textContent = quotaLabel(w);
  value.textContent = `${Math.round(used)}%`;
  fill.style.width = `${used}%`;
  row.dataset.level = used >= 95 ? "critical" : used >= 80 ? "warning" : "";
  const pace = elapsedPercent(w);
  tick.hidden = pace === null;
  if (pace !== null) tick.style.left = `${pace}%`;
  row.title = [`${w.bucket}: ${tenth(used)}% used, ${tenth(Math.max(0, 100 - used))}% left`,
    w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "reset time unknown",
    ...(pace === null ? [] : [`mark: ${Math.round(pace)}% of the window has passed`])].join(" · ");
}

// five_hour → 5h, seven_day_opus → 7d opus, codex:primary over 300 minutes → 5h.
function quotaLabel(w) {
  const name = w.bucket.replace(/^codex:/, "").replace(/^five_hour/, "5h").replace(/^seven_day/, "7d").replaceAll("_", " ");
  const m = w.windowMinutes;
  if (!/^(primary|secondary)$/.test(name) || !m) return name;
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

const tenth = (value) => Math.round(value * 10) / 10;

function elapsedPercent(w) {
  if (!w.windowMinutes || !w.resetsAt) return null;
  const elapsed = 1 - (Date.parse(w.resetsAt) - Date.now()) / (w.windowMinutes * 60_000);
  return elapsed >= 0 && elapsed <= 1 ? elapsed * 100 : null;
}

// history.ts COST_* bits that make a cost partly estimated.
const COST_ESTIMATED = 1 | 2 | 8;
function formatCost(value) {
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`;
  if (value >= 0.01 || value === 0) return `$${value.toFixed(2)}`;
  return "<$0.01";
}
function costTitle(estimated, unpriced) {
  return ["At the providers' published API prices; subscription accounts are not billed this.",
    ...(estimated ? ["Partly estimated: cache writes recorded before the router noted their duration (priced as 1-hour), or output never reported."] : []),
    ...(unpriced ? [`${unpriced} requests have no price for their model.`] : [])].join(" ");
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
