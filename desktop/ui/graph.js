// Canvas traffic graph after rstorrent's speed panel: complete buckets only,
// a scroll phase that slides one bucket per bucket interval, a 1/2/5 y scale
// that rises at once and decays downward, and an exact-bucket cursor.
// Panes stack on a shared time axis and each keeps its own labelled scale.

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return abs >= 10 || value === 0 ? String(Math.round(value)) : value.toFixed(1);
}

export function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(Math.abs(value) >= 100 ? 0 : 1) : Math.round(value)} ${units[unit]}`;
}

/** Smallest 1/2/5×10ⁿ at or above the value. */
export function niceMaximum(value, floor = 1) {
  const target = Math.max(value, floor);
  const power = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 5, 10]) if (step * power >= target) return step * power;
  return 10 * power;
}

/** Fritsch–Carlson tangents: curves never overshoot between samples. */
function tangents(points) {
  const n = points.length, slopes = [], t = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x || 1));
  if (n < 2) return t;
  t[0] = slopes[0];
  t[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / slopes[i], b = t[i + 1] / slopes[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * slopes[i]; t[i + 1] = k * b * slopes[i]; }
  }
  return t;
}

function trace(ctx, points, reverse = false, move = true) {
  if (!points.length) return;
  const t = tangents(points);
  const order = reverse ? [...points.keys()].reverse() : [...points.keys()];
  const first = points[order[0]];
  if (move) ctx.moveTo(first.x, first.y); else ctx.lineTo(first.x, first.y);
  for (let k = 1; k < order.length; k++) {
    const i = order[k - 1], j = order[k], p = points[i], q = points[j], dx = (q.x - p.x) / 3;
    ctx.bezierCurveTo(p.x + dx, p.y + t[i] * dx, q.x - dx, q.y - t[j] * dx, q.x, q.y);
  }
}

/** Splits indices into runs of covered buckets. */
function runs(length, covered) {
  const result = [];
  let current = [];
  for (let i = 0; i < length; i++) {
    if (covered(i)) current.push(i);
    else if (current.length) { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}

/**
 * panes: [{ title, series: [{ key, label, color }], stacked, direction: "up" | "down",
 *           format(value), unit, maximum? }]
 */
export class TrafficGraph {
  #canvas;
  #tooltip;
  #panes = [];
  #data;
  #phaseStart = 0;
  #animating = false;
  #frame = 0;
  #cursor = null;
  #scales = new Map();
  #lastDraw = 0;
  #live = true;
  #stale = false;
  #visible = true;
  #rate = true;
  constructor(canvas, tooltip) {
    this.#canvas = canvas;
    this.#tooltip = tooltip;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointermove", (event) => this.#pointer(event));
    canvas.addEventListener("pointerleave", () => { this.#cursor = null; this.draw(); });
    canvas.addEventListener("keydown", (event) => this.#key(event));
    canvas.addEventListener("blur", () => { this.#cursor = null; this.draw(); });
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => this.draw());
  }
  /** `rate` converts bucket sums to per-second values; gauges keep raw values. */
  configure(panes, { live = true, rate = true } = {}) {
    this.#panes = panes;
    this.#live = live;
    this.#rate = rate;
    this.#scales.clear();
    this.draw();
  }
  get data() { return this.#data; }
  set visible(value) { this.#visible = value; if (value) this.#kick(); }
  set stale(value) { if (this.#stale !== value) { this.#stale = value; this.draw(); } }
  /** Accepts a snapshot or an append; returns false when the caller must refetch. */
  update(message) {
    const data = message.data;
    if (message.type === "snapshot") this.#data = structuredClone(data);
    else {
      const current = this.#data;
      if (!current || data.epoch !== current.epoch || data.range !== current.range || data.scope !== current.scope || data.start !== current.completeThrough + 1) return false;
      for (const [key, values] of Object.entries(data.series)) {
        const column = (this.#data.series[key] ??= new Array(this.#data.completeThrough - this.#data.start + 1).fill(null));
        column.push(...values);
      }
      this.#data.completeThrough = data.completeThrough;
      const excess = this.#data.completeThrough - this.#data.start + 1 - this.#data.count;
      if (excess > 0) {
        this.#data.start += excess;
        for (const column of Object.values(this.#data.series)) column.splice(0, excess);
      }
    }
    this.#phaseStart = performance.now();
    this.#kick();
    return true;
  }
  /** Value per second (or raw gauge) for a series at a bucket index. */
  value(key, index) {
    const column = this.#data?.series[key];
    let raw = column?.[index];
    // Gauges hold their last sample until the next one.
    if (!this.#rate && (raw === null || raw === undefined)) {
      for (let i = index - 1; i >= 0 && (raw === null || raw === undefined); i--) raw = column[i];
    }
    if (raw === null || raw === undefined) return null;
    return this.#rate ? raw / (this.#data.bucketMs / 1000) : raw;
  }
  #kick() {
    if (this.#frame || !this.#visible) return;
    this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.draw(); });
  }
  #phase(now) {
    if (!this.#data || !this.#live || this.#stale || !this.#visible || prefersReducedMotion() || document.hidden) return 0;
    return Math.min(1, (now - this.#phaseStart) / this.#data.bucketMs);
  }
  #layout(width, height) {
    const left = 54, right = 10, top = 6, bottom = 18, gap = 22, titles = 16;
    const panes = this.#panes.length || 1;
    const paneHeight = Math.max(30, (height - top - bottom - titles * panes - gap * (panes - 1)) / panes);
    return this.#panes.map((pane, i) => {
      const y0 = top + i * (paneHeight + titles + gap) + titles;
      return { pane, left, right: width - right, top: y0, bottom: y0 + paneHeight, height: paneHeight, titleY: y0 - 5 };
    });
  }
  #scale(pane, index, maximum, now) {
    const target = pane.maximum ?? niceMaximum(maximum * 1.1, pane.floor ?? 1);
    const previous = this.#scales.get(index);
    let value = target;
    if (previous && target < previous.value) {
      // Fall with a two-second half-life; rise immediately.
      value = Math.max(target, previous.value * 0.5 ** ((now - previous.at) / 2000));
    }
    this.#scales.set(index, { value, at: now });
    return { value, settling: value > target * 1.0001 };
  }
  draw() {
    const canvas = this.#canvas;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(canvas);
    const ink = style.getPropertyValue("--chart-muted").trim() || "#898781";
    const grid = style.getPropertyValue("--chart-grid").trim() || "#e1e0d9";
    const text = style.getPropertyValue("--text").trim() || "#28312e";
    const surface = style.getPropertyValue("--surface").trim() || "#fff";
    ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    const now = performance.now();
    const phase = this.#phase(now);
    const data = this.#data;
    const length = data ? data.completeThrough - data.start + 1 : 0;
    const count = data?.count ?? 120;
    let settling = false;
    for (const [index, area] of this.#layout(width, height).entries()) {
      const { pane, left, right } = area;
      const spacing = (right - left) / Math.max(1, count - 1);
      const x = (i) => right - (length - 1 - i + phase) * spacing;
      const covered = (i) => pane.series.some(s => this.value(s.key, i) !== null);
      // Stack values bottom-up in series order.
      const stacks = pane.series.map(() => new Array(length).fill(0));
      let maximum = 0;
      for (let i = 0; i < length; i++) {
        let total = 0;
        pane.series.forEach((s, k) => {
          const v = Math.max(0, this.value(s.key, i) ?? 0);
          total = pane.stacked ? total + v : v;
          stacks[k][i] = total;
          if (total > maximum && x(i) >= left - spacing) maximum = total;
        });
      }
      const scale = this.#scale(pane, index, maximum, now);
      settling ||= scale.settling;
      const down = pane.direction === "down";
      const baseline = down ? area.top : area.bottom;
      const y = (v) => down ? area.top + (v / scale.value) * area.height : area.bottom - (v / scale.value) * area.height;
      // Title and recessive hairline grid.
      ctx.fillStyle = text;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(pane.title, left, area.titleY);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = ink;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const fraction of [0, 0.5, 1]) {
        const gy = Math.round(y(scale.value * fraction)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, gy);
        ctx.lineTo(right, gy);
        ctx.stroke();
        if (fraction) ctx.fillText(pane.format(scale.value * fraction), left - 6, gy);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, area.top - 1, right - left, area.height + 2);
      ctx.clip();
      for (const run of runs(length, covered)) {
        pane.series.forEach((s, k) => {
          const top = run.map(i => ({ x: x(i), y: y(stacks[k][i]) }));
          const below = run.map(i => ({ x: x(i), y: pane.stacked && k ? y(stacks[k - 1][i]) : baseline }));
          if (pane.fill !== false) {
            ctx.beginPath();
            trace(ctx, top);
            if (pane.stacked && k) trace(ctx, below, true, false);
            else { ctx.lineTo(top.at(-1).x, baseline); ctx.lineTo(top[0].x, baseline); }
            ctx.closePath();
            ctx.globalAlpha = 0.28;
            ctx.fillStyle = s.color;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.beginPath();
          if (top.length === 1) ctx.arc(top[0].x, top[0].y, 1.5, 0, Math.PI * 2);
          else trace(ctx, top);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }
      ctx.restore();
      // Cursor hairline and markers.
      if (this.#cursor !== null && this.#cursor < length) {
        const cx = Math.round(x(this.#cursor)) + 0.5;
        ctx.strokeStyle = ink;
        ctx.beginPath();
        ctx.moveTo(cx, area.top);
        ctx.lineTo(cx, area.bottom);
        ctx.stroke();
        pane.series.forEach((s, k) => {
          if (this.value(s.key, this.#cursor) === null) return;
          ctx.beginPath();
          ctx.arc(cx, y(stacks[k][this.#cursor]), 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.strokeStyle = surface;
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
        });
      }
    }
    // Shared time axis: only the ends are labelled.
    const areas = this.#layout(width, height), last = areas.at(-1);
    if (last && data) {
      ctx.fillStyle = ink;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const span = data.count * data.bucketMs;
      ctx.fillText(this.#live ? `−${spanLabel(span)}` : new Date(Date.now() - span).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), last.left, height - 4);
      ctx.textAlign = "right";
      ctx.fillText(this.#stale ? "updates paused" : "now", last.right, height - 4);
    }
    this.#tooltipUpdate();
    if ((phase > 0 && phase < 1) || settling) this.#kick();
  }
  #index(clientX) {
    const data = this.#data;
    if (!data) return null;
    const rect = this.#canvas.getBoundingClientRect(), area = this.#layout(rect.width, rect.height)[0];
    if (!area) return null;
    const length = data.completeThrough - data.start + 1, spacing = (area.right - area.left) / Math.max(1, data.count - 1);
    const offset = Math.round((area.right - (clientX - rect.left)) / spacing - this.#phase(performance.now()));
    const index = length - 1 - offset;
    return index >= 0 && index < length ? index : null;
  }
  #pointer(event) {
    this.#cursor = this.#index(event.clientX);
    this.draw();
  }
  #key(event) {
    const data = this.#data;
    if (!data) return;
    const length = data.completeThrough - data.start + 1;
    if (event.key === "ArrowLeft") this.#cursor = Math.max(0, (this.#cursor ?? length) - 1);
    else if (event.key === "ArrowRight") this.#cursor = Math.min(length - 1, (this.#cursor ?? length - 2) + 1);
    else if (event.key === "Home") this.#cursor = 0;
    else if (event.key === "End") this.#cursor = length - 1;
    else if (event.key === "Escape") this.#cursor = null;
    else return;
    event.preventDefault();
    this.draw();
  }
  #tooltipUpdate() {
    const tooltip = this.#tooltip, data = this.#data;
    if (this.#cursor === null || !data) { tooltip.hidden = true; return; }
    const bucket = data.start + this.#cursor;
    const at = new Date(bucket * data.bucketMs);
    const time = data.bucketMs >= 3_600_000 ? at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })
      : data.bucketMs >= 60_000 ? at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : at.toLocaleTimeString();
    const rows = [];
    for (const pane of this.#panes) for (const s of pane.series) {
      const v = this.value(s.key, this.#cursor);
      rows.push(`<div class="tooltip-row"><span class="swatch" style="background:${s.color}"></span>${escape(s.label)}<b>${v === null ? "no data" : `${pane.format(v)}${pane.unit ?? ""}`}</b></div>`);
    }
    tooltip.innerHTML = `<div class="tooltip-time">${escape(time)}</div>${rows.join("")}`;
    tooltip.hidden = false;
    const rect = this.#canvas.getBoundingClientRect();
    const area = this.#layout(rect.width, rect.height)[0];
    const length = data.completeThrough - data.start + 1, spacing = (area.right - area.left) / Math.max(1, data.count - 1);
    const cx = area.right - (length - 1 - this.#cursor + this.#phase(performance.now())) * spacing;
    // Keep the newest data visible: flip to the left of the cursor in the right half.
    const leftSide = cx > rect.width / 2 ? cx - tooltip.offsetWidth - 12 : cx + 12;
    tooltip.style.left = `${Math.min(rect.width - tooltip.offsetWidth - 4, Math.max(4, leftSide))}px`;
    tooltip.style.top = "8px";
  }
}

function spanLabel(ms) {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} days`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Small single-series line for table rows. */
export function sparkline(canvas, values, color) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => ({ x: (i / Math.max(1, values.length - 1)) * (width - 2) + 1, y: height - 2 - (v / max) * (height - 4) }));
  if (points.length < 2) return;
  ctx.beginPath();
  trace(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
