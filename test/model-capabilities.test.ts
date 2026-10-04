import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCapabilities, supportsThinking, validThinking } from "../src/model-capabilities.ts";
import { PoolEvidence } from "../src/pools.ts";

test("catalogs preserve explicit native effort capabilities without guessing unknown models", () => {
  const codex = { id: "fixture", name: "Fixture", ...modelCapabilities("codex", {
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "ultra" }, { effort: "future" }], default_reasoning_level: "low", context_window: 1234,
  }) };
  assert.equal(codex.contextWindow, 1234);
  assert.equal(codex.defaultReasoningEffort, "low");
  assert(supportsThinking(codex, "on:max"));
  assert(!supportsThinking(codex, "on:high"));
  assert(supportsThinking(codex, "off"));
  const claude = { id: "fixture", name: "Fixture", ...modelCapabilities("claude", {
    max_input_tokens: 200000, capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: false }, xhigh: { supported: true } }, thinking: { types: { adaptive: { supported: true } } } },
  }) };
  assert(supportsThinking(claude, "on:xhigh"));
  assert(!supportsThinking(claude, "on:high"));
  assert.deepEqual(modelCapabilities("claude", { id: "unknown" }), {});
  assert(!supportsThinking({ id: "unknown", name: "Unknown" }, "on:high"));
  assert(!validThinking("on:future"));
  assert(!supportsThinking(undefined, "auto"));
});

test("discovery coalesces catalog-only work and invalidation rejects late results", async () => {
  let calls = 0, quotaCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const evidence = new PoolEvidence(async () => { calls++; await gate; return [{ id: "fixture", name: "Fixture" }]; }, async () => { quotaCalls++; throw Error(); });
  const signal = new AbortController().signal;
  const first = evidence.discover(["a"], signal, () => true);
  const second = evidence.discover(["a"], signal, () => true);
  evidence.invalidate("a"); release(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(quotaCalls, 0); assert.equal(evidence.get("a").catalogAt, null);
  await evidence.discover(["a", "ungranted"], signal, id => id === "a");
  await evidence.discover(["a"], signal, () => true);
  assert.equal(calls, 2); assert.equal(evidence.get("ungranted").catalogAt, null);
});

test("discovery backs off failures and cancellation admits no queued account reads", async () => {
  let calls = 0;
  const failed = new PoolEvidence(async () => { calls++; throw Error(); }, async () => { throw Error(); });
  await failed.discover(["a"], new AbortController().signal, () => true);
  await failed.discover(["a"], new AbortController().signal, () => true);
  assert.equal(calls, 1);
  const abort = new AbortController();
  const evidence = new PoolEvidence(async () => { calls++; abort.abort(new Error("cancelled")); return []; }, async () => { throw Error(); });
  await assert.rejects(evidence.discover(Array.from({ length: 16 }, (_, n) => String(n)), abort.signal, () => true), /cancelled/);
  assert.equal(calls, 2);
});
