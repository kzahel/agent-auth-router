import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_EVENT_CHARS, USAGE_FIELDS, UsageTap, usageFromTail, zeroUsage, type UsageFigures } from "../src/usage.ts";
import type { Provider } from "../src/types.ts";

function run(provider: Provider, contentType: string, chunks: (string | Buffer)[]) {
  const totals = zeroUsage(), deltas: UsageFigures[] = [], models: string[] = [];
  const tap = new UsageTap(provider, contentType, {
    model: (model) => models.push(model),
    delta: (change) => { deltas.push(change); for (const f of USAGE_FIELDS) totals[f] += change[f]; },
  });
  for (const chunk of chunks) tap.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  tap.end();
  return { totals, deltas, models, tap };
}

const sse = (events: object[], newline = "\n") =>
  events.map((e) => `event: ${(e as { type: string }).type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join("");

const claudeEvents = [
  { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 12, cache_creation_input_tokens: 30, cache_read_input_tokens: 900, output_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a".repeat(400) } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "b".repeat(40) } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 77 } },
  { type: "message_stop" },
];

describe("usage tap", () => {
  test("Claude streams: provider figures win over the estimate at any chunk boundary", () => {
    const text = sse(claudeEvents);
    const whole = run("claude", "text/event-stream", [text]);
    assert.deepEqual(whole.totals, { input: 12, cacheRead: 900, cacheWrite: 30, output: 77, reasoning: 0 });
    assert.deepEqual(whole.models, ["claude-x"]);
    assert.equal(whole.tap.accumulator.final, true);
    assert.equal(whole.tap.accumulator.estimated, false);
    // Output rose with the estimate (440 chars / 4) before the final figure corrected it down.
    assert.equal(whole.deltas[1]!.output, 99);
    assert.equal(whole.deltas.at(-1)!.output, 77 - 110);
    // Every two-way split, and byte-at-a-time, gives the same totals, including inside UTF-8 sequences.
    const bytes = Buffer.from(sse([{ ...claudeEvents[0]!, message: { model: "claude-é", usage: { input_tokens: 5 } } }, claudeEvents[3]!]));
    for (let at = 1; at < bytes.length; at += 7) {
      const split = run("claude", "text/event-stream", [bytes.subarray(0, at), bytes.subarray(at)]);
      assert.deepEqual(split.totals, { input: 5, cacheRead: 0, cacheWrite: 0, output: 77, reasoning: 0 }, `split at ${at}`);
      assert.deepEqual(split.models, ["claude-é"]);
    }
    const single = run("claude", "text/event-stream", [...bytes].map((b) => Buffer.from([b])));
    assert.equal(single.totals.output, 77);
    assert.equal(run("claude", "text/event-stream; charset=utf-8", [sse(claudeEvents, "\r\n")]).totals.output, 77, "CRLF framing");
  });

  test("an interrupted stream keeps known input and an estimated output", () => {
    const partial = run("claude", "text/event-stream", [sse(claudeEvents.slice(0, 2))]);
    assert.equal(partial.totals.input, 12);
    assert.equal(partial.totals.output, 100);
    assert.equal(partial.tap.accumulator.final, false);
    assert.equal(partial.tap.accumulator.estimated, true);
  });

  test("Codex streams: cached input and reasoning are split out of the totals", () => {
    const events = [
      { type: "response.created", response: { model: "gpt-x" } },
      { type: "response.output_text.delta", delta: "x".repeat(80) },
      { type: "response.completed", response: { model: "gpt-x", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } } } },
    ];
    const result = run("codex", "text/event-stream", [sse(events)]);
    assert.deepEqual(result.totals, { input: 200, cacheRead: 800, cacheWrite: 0, output: 50, reasoning: 20 });
    assert.deepEqual(result.models, ["gpt-x", "gpt-x"]);
  });

  test("oversized events keep only a bounded tail and still find the final usage", () => {
    const huge = "y".repeat(MAX_EVENT_CHARS + 10);
    const event = { type: "response.completed", response: { output: [{ content: huge }], usage: { input_tokens: 10, output_tokens: 3 } } };
    const text = sse([event]);
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += 65_536) chunks.push(text.slice(at, at + 65_536));
    const result = run("codex", "text/event-stream", chunks);
    assert.deepEqual(result.totals, { input: 10, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 0 });
    assert.deepEqual(usageFromTail('{"a":"\\"usage\\": {","usage": {"output_tokens": 4, "x": "}"}}'), { output_tokens: 4, x: "}" });
  });

  test("non-streaming JSON, malformed and unknown events", () => {
    const json = run("claude", "application/json", [JSON.stringify({ type: "message", model: "claude-y", usage: { input_tokens: 3, output_tokens: 9 } })]);
    assert.deepEqual(json.totals, { input: 3, cacheRead: 0, cacheWrite: 0, output: 9, reasoning: 0 });
    const compact = run("codex", "application/json", [JSON.stringify({ output: [], usage: { input_tokens: 40, output_tokens: 6 } })]);
    assert.equal(compact.totals.input, 40);
    const noisy = run("claude", "text/event-stream", [": ping\n\nevent: x\ndata: {not json\n\ndata: [DONE]\n\n", sse([{ type: "unknown_type", usage: { input_tokens: 999 } }]), sse(claudeEvents.slice(3))]);
    assert.deepEqual(noisy.totals, { input: 0, cacheRead: 0, cacheWrite: 0, output: 77, reasoning: 0 });
    const negative = run("claude", "text/event-stream", [sse([{ type: "message_delta", usage: { output_tokens: -5, input_tokens: "7" } }])]);
    assert.deepEqual(negative.totals, zeroUsage(), "only finite, non-negative numbers count");
  });
});
