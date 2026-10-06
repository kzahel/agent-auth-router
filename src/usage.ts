// Passive usage extraction from relayed provider responses. The tap sees a
// copy of bytes already flowing to the client; it never alters, delays or
// buffers the relayed stream. Only numbers and the model name leave this
// module: prompt and response content is discarded as it is parsed.

import { StringDecoder } from "node:string_decoder";
import type { Provider } from "./types.ts";

export interface UsageFigures {
  /** Input not served from cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output, including reasoning where the provider counts it as output. */
  output: number;
  /** Reasoning output; a subset of output. */
  reasoning: number;
}

export const USAGE_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;
export const zeroUsage = (): UsageFigures => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/** Coarse live estimate for streamed output; replaced by provider figures. */
export const CHARS_PER_TOKEN = 4;
/** Largest event parsed whole; larger events keep a bounded head and tail. */
export const MAX_EVENT_CHARS = 1024 * 1024;
const TAIL_CHARS = 64 * 1024;
const HEAD_CHARS = 512;

export interface UsageSink {
  model(model: string): void;
  /** Change since the previous call; output may be negative when a provider figure corrects the estimate. */
  delta(change: UsageFigures): void;
}

/**
 * Per-request accounting. Provider-reported figures are authoritative. While
 * a response streams, output follows a characters-per-token estimate; the
 * final provider figure then replaces it, so completed totals are exact.
 */
export class UsageAccumulator {
  readonly reported = zeroUsage();
  readonly recorded = zeroUsage();
  estimateChars = 0;
  /** True once the provider reported its final output count. */
  final = false;
  report(values: Partial<UsageFigures>, final: boolean): UsageFigures {
    for (const field of USAGE_FIELDS) {
      const value = values[field];
      if (value !== undefined && Number.isFinite(value) && value >= 0) this.reported[field] = Math.round(value);
    }
    if (final) this.final = true;
    return this.settle();
  }
  text(chars: number): UsageFigures {
    if (this.final) return zeroUsage();
    this.estimateChars += chars;
    return this.settle();
  }
  get estimatedOutput(): number { return Math.round(this.estimateChars / CHARS_PER_TOKEN); }
  /** True when output includes an estimate that no provider figure replaced. */
  get estimated(): boolean { return !this.final && this.recorded.output > this.reported.output; }
  private settle(): UsageFigures {
    const target = { ...this.reported, output: this.final ? this.reported.output : Math.max(this.reported.output, this.estimatedOutput) };
    const change = zeroUsage();
    for (const field of USAGE_FIELDS) {
      change[field] = target[field] - this.recorded[field];
      this.recorded[field] = target[field];
    }
    return change;
  }
}

const isZero = (u: UsageFigures) => USAGE_FIELDS.every(f => u[f] === 0);
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Claude reports input excluding cache; cache reads and writes are separate. */
export function claudeUsage(raw: unknown): Partial<UsageFigures> | undefined {
  const usage = obj(raw);
  if (!usage) return undefined;
  const values: Partial<UsageFigures> = {};
  const input = num(usage.input_tokens), read = num(usage.cache_read_input_tokens), write = num(usage.cache_creation_input_tokens), output = num(usage.output_tokens);
  if (input !== undefined) values.input = input;
  if (read !== undefined) values.cacheRead = read;
  if (write !== undefined) values.cacheWrite = write;
  if (output !== undefined) values.output = output;
  return values;
}

/** Responses API input includes cached tokens, and output includes reasoning. */
export function codexUsage(raw: unknown): Partial<UsageFigures> | undefined {
  const usage = obj(raw);
  if (!usage) return undefined;
  const values: Partial<UsageFigures> = {};
  const input = num(usage.input_tokens), cached = num(obj(usage.input_tokens_details)?.cached_tokens) ?? 0;
  const output = num(usage.output_tokens), reasoning = num(obj(usage.output_tokens_details)?.reasoning_tokens);
  if (input !== undefined) { values.input = Math.max(0, input - cached); values.cacheRead = Math.min(cached, input); }
  if (output !== undefined) values.output = output;
  if (reasoning !== undefined) values.reasoning = reasoning;
  return values;
}

/**
 * Finds the last `"usage": { … }` object in a bounded tail of an oversized
 * event. Codex's final event carries the whole response object, and its usage
 * sits at the end, so the tail is enough without buffering the output.
 */
export function usageFromTail(text: string): unknown {
  for (let at = text.lastIndexOf('"usage"'); at >= 0; at = text.lastIndexOf('"usage"', at - 1)) {
    const open = text.indexOf("{", at);
    if (open < 0 || !/^"usage"\s*:\s*$/.test(text.slice(at, open))) continue;
    let depth = 0, inString = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(open, i + 1)); } catch { break; }
      }
    }
  }
  return undefined;
}

/** Routes whose responses carry inference usage. */
export function tapsUsage(provider: Provider, route: string): boolean {
  return provider === "claude" ? route === "/v1/messages" : route === "/responses" || route === "/responses/compact";
}

/**
 * Incremental SSE/JSON reader. Splits events across arbitrary chunk
 * boundaries, parses only what usage needs and bounds memory per event.
 */
export class UsageTap {
  private readonly provider: Provider;
  private readonly sink: UsageSink;
  readonly accumulator = new UsageAccumulator();
  private readonly decoder = new StringDecoder("utf8");
  private readonly sse: boolean;
  private line = "";
  private data = "";
  private dataChars = 0;
  private head = "";
  private tail = "";
  private overflow = false;
  private dataLines = 0;
  private done = false;
  constructor(provider: Provider, contentType: string | undefined, sink: UsageSink) {
    this.provider = provider;
    this.sink = sink;
    this.sse = /^text\/event-stream\b/i.test(contentType ?? "");
  }
  push(chunk: Buffer): void {
    if (this.done) return;
    const text = this.decoder.write(chunk);
    if (!this.sse) { this.append(text); return; }
    let start = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
      this.feedLine(text.slice(start, i), true);
      start = i + 1;
    }
    if (start < text.length) this.feedLine(text.slice(start), false);
  }
  end(): void {
    if (this.done) return;
    const rest = this.decoder.end();
    if (this.sse) { if (rest) this.feedLine(rest, false); if (this.line) this.feedLine("", true); this.dispatch(); }
    else { this.append(rest); this.dispatch(); }
    this.done = true;
  }
  /** Lines can be huge; only the data field accumulates, under the event bound. */
  private lineIsData: boolean | undefined;
  private feedLine(part: string, complete: boolean): void {
    if (this.lineIsData === undefined) {
      this.line += part;
      // Decide the field once its name is known; keep only a short prefix until then.
      if (this.line.length >= 5 || complete) {
        const field = this.line;
        this.line = "";
        if (field.startsWith("data:")) {
          this.lineIsData = true;
          if (this.dataLines++) this.append("\n");
          this.append(field.slice(field[5] === " " ? 6 : 5));
        } else if (field.replace(/\r$/, "") === "" && complete) {
          this.dispatch();
          return;
        } else this.lineIsData = false;
      }
    } else if (this.lineIsData) this.append(part);
    if (complete) {
      if (this.lineIsData) this.trimCarriageReturn();
      this.lineIsData = undefined;
      this.line = "";
    }
  }
  private trimCarriageReturn(): void {
    if (this.overflow) { if (this.tail.endsWith("\r")) this.tail = this.tail.slice(0, -1); }
    else if (this.data.endsWith("\r")) this.data = this.data.slice(0, -1);
  }
  private append(text: string): void {
    if (!text) return;
    this.dataChars += text.length;
    if (!this.overflow && this.dataChars > MAX_EVENT_CHARS) {
      this.overflow = true;
      this.head = this.data.slice(0, HEAD_CHARS);
      this.tail = this.data.slice(-TAIL_CHARS);
      this.data = "";
    }
    if (this.overflow) this.tail = (this.tail + text).slice(-TAIL_CHARS);
    else this.data += text;
  }
  private dispatch(): void {
    const overflow = this.overflow, data = this.data, head = this.head, tail = this.tail;
    this.data = this.head = this.tail = "";
    this.dataChars = this.dataLines = 0;
    this.overflow = false;
    if (!overflow && !data) return;
    try {
      if (overflow) this.oversized(head, tail);
      else this.event(JSON.parse(data));
    } catch { /* Unknown or malformed events are ignored. */ }
  }
  private emit(change: UsageFigures): void { if (!isZero(change)) this.sink.delta(change); }
  private report(values: Partial<UsageFigures> | undefined, final: boolean): void {
    if (values) this.emit(this.accumulator.report(values, final));
  }
  private model(value: unknown): void {
    const model = str(value);
    if (model && model.length <= 200 && !/[\x00-\x1f\x7f]/.test(model)) this.sink.model(model);
  }
  private oversized(head: string, tail: string): void {
    const type = head.match(/"type"\s*:\s*"([a-z_.]+)"/)?.[1];
    const usage = usageFromTail(tail);
    if (this.provider === "claude") this.report(claudeUsage(usage), type === "message_delta" || type === "message");
    else this.report(codexUsage(usage), type !== undefined && type.startsWith("response.") ? FINAL_CODEX.has(type) : true);
  }
  private event(value: unknown): void {
    const event = obj(value);
    if (!event) return;
    const type = str(event.type);
    if (this.provider === "claude") {
      if (type === "message_start") {
        const message = obj(event.message);
        this.model(message?.model);
        // message_start's output count is a placeholder, not the final figure.
        this.report(claudeUsage(message?.usage), false);
      } else if (type === "content_block_delta") {
        const delta = obj(event.delta);
        const text = str(delta?.text) ?? str(delta?.thinking) ?? str(delta?.partial_json);
        if (text) this.emit(this.accumulator.text(text.length));
      } else if (type === "message_delta") this.report(claudeUsage(event.usage), true);
      else if (type === "message" || (!type && event.usage)) { this.model(event.model); this.report(claudeUsage(event.usage), true); }
      return;
    }
    if (type === "response.created" || type === "response.in_progress") this.model(obj(event.response)?.model);
    else if (type && FINAL_CODEX.has(type)) { const response = obj(event.response); this.model(response?.model); this.report(codexUsage(response?.usage), true); }
    else if (type && type.endsWith(".delta")) { const delta = str(event.delta); if (delta) this.emit(this.accumulator.text(delta.length)); }
    else if (!type || type === "response") {
      // Non-streaming JSON: a response object, possibly wrapped.
      const response = obj(event.response) ?? event;
      this.model(response.model);
      this.report(codexUsage(response.usage), true);
    }
  }
}

const FINAL_CODEX = new Set(["response.completed", "response.failed", "response.incomplete"]);
