// Canvas traffic graph after rstorrent's speed panel: complete buckets only,
// a scroll phase that slides one bucket per bucket interval, a 1/2/5 y scale
// that snaps to the visible maximum, and an exact-bucket cursor.
// Panes stack on a shared time axis and each keeps its own labelled scale.

import type { HistoryData } from "../protocol/types.ts";

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smallest 1/2/5×10ⁿ at or above the value. */
export function niceMaximum(value: number, floor = 1): number {
  const target = Math.max(value, floor);
  const power = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 5, 10]) if (step * power >= target) return step * power;
  return 10 * power;
}

interface Point { x: number; y: number }

/** Fritsch–Carlson tangents: curves never overshoot between samples. */
export function tangents(points: Point[]): number[] {
  const n = points.length, slopes: number[] = [], t = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1]!.y - points[i]!.y) / (points[i + 1]!.x - points[i]!.x || 1));
  if (n < 2) return t;
  t[0] = slopes[0]!;
  t[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = slopes[i - 1]! * slopes[i]! <= 0 ? 0 : (slopes[i - 1]! + slopes[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    const slope = slopes[i]!;
    if (slope === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i]! / slope, b = t[i + 1]! / slope, h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * slope; t[i + 1] = k * b * slope; }
  }
  return t;
}

function trace(ctx: CanvasRenderingContext2D, points: Point[], reverse = false, move = true) {
  if (!points.length) return;
  const t = tangents(points);
  const order = reverse ? [...points.keys()].reverse() : [...points.keys()];
  const first = points[order[0]!]!;
  if (move) ctx.moveTo(first.x, first.y); else ctx.lineTo(first.x, first.y);
  for (let k = 1; k < order.length; k++) {
    const i = order[k - 1]!, j = order[k]!, p = points[i]!, q = points[j]!, dx = (q.x - p.x) / 3;
    ctx.bezierCurveTo(p.x + dx, p.y + t[i]! * dx, q.x - dx, q.y - t[j]! * dx, q.x, q.y);
  }
}

/** Splits indices into runs of covered buckets. */
export function runs(length: number, covered: (index: number) => boolean): number[][] {
  const result: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < length; i++) {
    if (covered(i)) current.push(i);
    else if (current.length) { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}

export interface GraphSeries { key: string; label: string; color: string; line?: boolean | undefined }
/**
 * In a stacked pane, series stack as solid bands unless marked `line`, which
 * draw on top unstacked; other panes draw lines. Context series are not
 * drawn but are listed in the tooltip.
 */
export interface GraphPane {
  title: string;
  series: GraphSeries[];
  context?: { key: string; label: string; color?: string }[];
  stacked?: boolean;
  format(value: number): string;
  unit?: string;
  maximum?: number;
  floor?: number;
}

/** A history snapshot or append, as the `history` subscription delivers it. */
export interface GraphMessage { type: string; data: HistoryData }

export class TrafficGraph {
  #canvas: HTMLCanvasElement;
  #tooltip: HTMLElement;
  #panes: GraphPane[] = [];
  #data: HistoryData | undefined;
  #phaseStart = 0;
  #frame = 0;
  #cursor: number | null = null;
  #live = true;
  #stale = false;
  #visible = true;
  #rate = true;
  #disconnect: () => void;
  constructor(canvas: HTMLCanvasElement, tooltip: HTMLElement) {
    this.#canvas = canvas;
    this.#tooltip = tooltip;
    const redraw = () => this.draw();
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    const leave = () => { this.#cursor = null; this.draw(); };
    const pointer = (event: PointerEvent) => this.#pointer(event);
    const key = (event: KeyboardEvent) => this.#key(event);
    canvas.addEventListener("pointermove", pointer);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("blur", leave);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener?.("change", redraw);
    this.#disconnect = () => {
      resize.disconnect();
      canvas.removeEventListener("pointermove", pointer);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("blur", leave);
      scheme.removeEventListener?.("change", redraw);
      if (this.#frame) cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    };
  }
  /** Stops observing the canvas; the graph is not used again. */
  dispose() { this.#visible = false; this.#disconnect(); }
  /** `rate` converts bucket sums to per-second values; gauges keep raw values. */
  configure(panes: GraphPane[], { live = true, rate = true }: { live?: boolean; rate?: boolean } = {}) {
    this.#panes = panes;
    this.#live = live;
    this.#rate = rate;
    this.draw();
  }
  get data(): HistoryData | undefined { return this.#data; }
  set visible(value: boolean) { this.#visible = value; if (value) this.#kick(); }
  set stale(value: boolean) { if (this.#stale !== value) { this.#stale = value; this.draw(); } }
  /** Accepts a snapshot or an append; returns false when the caller must refetch. */
  update(message: GraphMessage): boolean {
    const data = message.data;
    if (message.type === "snapshot") this.#data = structuredClone(data);
    else {
      const current = this.#data;
      if (!current || data.epoch !== current.epoch || data.range !== current.range || data.scope !== current.scope || data.start !== current.completeThrough + 1) return false;
      for (const [key, values] of Object.entries(data.series)) {
        const column = (current.series[key] ??= new Array<number | null>(current.completeThrough - current.start + 1).fill(null));
        column.push(...values);
      }
      current.completeThrough = data.completeThrough;
      const excess = current.completeThrough - current.start + 1 - current.count;
      if (excess > 0) {
        current.start += excess;
        for (const column of Object.values(current.series)) column.splice(0, excess);
      }
    }
    this.#phaseStart = performance.now();
    this.#kick();
    return true;
  }
  /** Value per second (or raw gauge) for a series at a bucket index. */
  value(key: string, index: number): number | null {
    const column = this.#data?.series[key];
    let raw = column?.[index];
    // Gauges hold their last sample until the next one.
    if (!this.#rate && (raw === null || raw === undefined)) {
      for (let i = index - 1; i >= 0 && (raw === null || raw === undefined); i--) raw = column?.[i];
    }
    if (raw === null || raw === undefined) return null;
    return this.#rate ? raw / (this.#data!.bucketMs / 1000) : raw;
  }
  #kick() {
    if (this.#frame || !this.#visible) return;
    this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.draw(); });
  }
  #phase(now: number) {
    if (!this.#data || !this.#live || this.#stale || !this.#visible || prefersReducedMotion() || document.hidden) return 0;
    return Math.min(1, (now - this.#phaseStart) / this.#data.bucketMs);
  }
  #layout(width: number, height: number) {
    const left = 54, right = 10, top = 6, bottom = 18, gap = 22, titles = 16;
    const panes = this.#panes.length || 1;
    const paneHeight = Math.max(30, (height - top - bottom - titles * panes - gap * (panes - 1)) / panes);
    return this.#panes.map((pane, i) => {
      const y0 = top + i * (paneHeight + titles + gap) + titles;
      return { pane, left, right: width - right, top: y0, bottom: y0 + paneHeight, height: paneHeight, titleY: y0 - 5 };
    });
  }
  /** 1/2/5 steps above the visible maximum; it snaps rather than animating. */
  #scale(pane: GraphPane, maximum: number) {
    return pane.maximum ?? niceMaximum(maximum * 1.1, pane.floor ?? 1);
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
    if (!ctx) return;
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
    for (const area of this.#layout(width, height)) {
      const { pane, left, right } = area;
      const spacing = (right - left) / Math.max(1, count - 1);
      const x = (i: number) => right - (length - 1 - i + phase) * spacing;
      const covered = (i: number) => pane.series.some(s => this.value(s.key, i) !== null);
      // Stack band values bottom-up in series order; lines keep their own values.
      const banded = pane.series.map(s => !!pane.stacked && !s.line);
      // The band each one sits on; lastIndexOf would read -1 as "from the end".
      const below = banded.map((band, k) => band && k ? banded.lastIndexOf(true, k - 1) : -1);
      const stacks = pane.series.map(() => new Array<number>(length).fill(0));
      let maximum = 0;
      for (let i = 0; i < length; i++) {
        let total = 0;
        pane.series.forEach((s, k) => {
          const v = Math.max(0, this.value(s.key, i) ?? 0);
          const stack = stacks[k]!;
          stack[i] = banded[k] ? (total += v) : v;
          if (stack[i]! > maximum && x(i) >= left - spacing) maximum = stack[i]!;
        });
      }
      const scale = this.#scale(pane, maximum);
      const baseline = area.bottom;
      const y = (v: number) => area.bottom - (v / scale) * area.height;
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
        const gy = Math.round(y(scale * fraction)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, gy);
        ctx.lineTo(right, gy);
        ctx.stroke();
        if (fraction) ctx.fillText(pane.format(scale * fraction), left - 6, gy);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, area.top - 1, right - left, area.height + 2);
      ctx.clip();
      for (const run of runs(length, covered)) {
        const edges = pane.series.map((_, k) => run.map(i => ({ x: x(i), y: y(stacks[k]![i]!) })));
        const dot = (point: Point, color: string) => { ctx.beginPath(); ctx.arc(point.x, point.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); };
        // Bands first: a line per layer would sit on the band above it, so bands are solid.
        pane.series.forEach((s, k) => {
          if (!banded[k]) return;
          const top = edges[k]!;
          if (top.length === 1) { dot(top[0]!, s.color); return; }
          ctx.beginPath();
          trace(ctx, top);
          if (below[k]! >= 0) trace(ctx, edges[below[k]!]!, true, false);
          else { ctx.lineTo(top.at(-1)!.x, baseline); ctx.lineTo(top[0]!.x, baseline); }
          ctx.closePath();
          ctx.fillStyle = s.color;
          ctx.fill();
        });
        // A hairline of surface between stacked bands.
        const bands = pane.series.flatMap((_, k) => banded[k] ? [k] : []);
        if (run.length > 1) for (const k of bands.slice(0, -1)) {
          ctx.beginPath();
          trace(ctx, edges[k]!);
          ctx.strokeStyle = surface;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // Lines on top.
        pane.series.forEach((s, k) => {
          if (banded[k]) return;
          const line = edges[k]!;
          if (line.length === 1) { dot(line[0]!, s.color); return; }
          ctx.beginPath();
          trace(ctx, line);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }
      ctx.restore();
      // Cursor hairline and markers.
      const cursor = this.#cursor;
      if (cursor !== null && cursor < length) {
        const cx = Math.round(x(cursor)) + 0.5;
        ctx.strokeStyle = ink;
        ctx.beginPath();
        ctx.moveTo(cx, area.top);
        ctx.lineTo(cx, area.bottom);
        ctx.stroke();
        pane.series.forEach((s, k) => {
          if (this.value(s.key, cursor) === null) return;
          ctx.beginPath();
          ctx.arc(cx, y(stacks[k]![cursor]!), 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.strokeStyle = surface;
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
        });
      }
    }
    // Shared time axis: only the ends are labelled.
    const last = this.#layout(width, height).at(-1);
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
    if (phase > 0 && phase < 1) this.#kick();
  }
  #index(clientX: number) {
    const data = this.#data;
    if (!data) return null;
    const rect = this.#canvas.getBoundingClientRect(), area = this.#layout(rect.width, rect.height)[0];
    if (!area) return null;
    const length = data.completeThrough - data.start + 1, spacing = (area.right - area.left) / Math.max(1, data.count - 1);
    const offset = Math.round((area.right - (clientX - rect.left)) / spacing - this.#phase(performance.now()));
    const index = length - 1 - offset;
    return index >= 0 && index < length ? index : null;
  }
  #pointer(event: PointerEvent) {
    this.#cursor = this.#index(event.clientX);
    this.draw();
  }
  #key(event: KeyboardEvent) {
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
    const tooltip = this.#tooltip, data = this.#data, cursor = this.#cursor;
    if (cursor === null || !data) { tooltip.hidden = true; return; }
    const bucket = data.start + cursor;
    const at = new Date(bucket * data.bucketMs);
    const time = data.bucketMs >= 3_600_000 ? at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })
      : data.bucketMs >= 60_000 ? at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : at.toLocaleTimeString();
    const rows: HTMLElement[] = [];
    for (const pane of this.#panes) for (const s of [...pane.series, ...(pane.context ?? [])]) {
      const v = this.value(s.key, cursor);
      const row = element("div", "tooltip-row"), swatch = element("span", "swatch"), value = element("b");
      if (s.color) swatch.style.background = s.color;
      value.textContent = v === null ? "no data" : `${pane.format(v)}${pane.unit ?? ""}`;
      row.append(swatch, s.label, value);
      rows.push(row);
    }
    const heading = element("div", "tooltip-time");
    heading.textContent = time;
    tooltip.replaceChildren(heading, ...rows);
    tooltip.hidden = false;
    const rect = this.#canvas.getBoundingClientRect();
    const area = this.#layout(rect.width, rect.height)[0];
    if (!area) return;
    const length = data.completeThrough - data.start + 1, spacing = (area.right - area.left) / Math.max(1, data.count - 1);
    const cx = area.right - (length - 1 - cursor + this.#phase(performance.now())) * spacing;
    // Keep the newest data visible: flip to the left of the cursor in the right half.
    const leftSide = cx > rect.width / 2 ? cx - tooltip.offsetWidth - 12 : cx + 12;
    tooltip.style.left = `${Math.min(rect.width - tooltip.offsetWidth - 4, Math.max(4, leftSide))}px`;
    tooltip.style.top = "8px";
  }
}

function element(tag: string, className?: string) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

export function spanLabel(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} days`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** Small single-series line for table rows; `max` lets rows share a scale. Gaps draw as zero. */
export function sparkline(canvas: HTMLCanvasElement, values: (number | null)[], color: string, max = Math.max(1, ...values.map(v => v ?? 0))) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const points = values.map((v, i) => ({ x: (i / Math.max(1, values.length - 1)) * (width - 2) + 1, y: height - 2 - ((v ?? 0) / max) * (height - 4) }));
  if (points.length < 2) return;
  ctx.beginPath();
  trace(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
