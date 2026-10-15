import assert from "node:assert/strict";
import { test } from "node:test";
import { COST_ESTIMATED_CACHE, COST_ESTIMATED_MODE, COST_ESTIMATED_OUTPUT, COST_UNPRICED } from "../src/history.ts";
import { findModel, priceRequest, type PricedRequest, type PriceProvider } from "../src/pricing.ts";
import { zeroUsage, type UsageFigures } from "../src/usage.ts";

const at = Date.parse("2026-10-15T12:00:00Z");
const request = (model: string, usage: Partial<UsageFigures>, extra: Partial<PricedRequest> = {}): PricedRequest => ({
  provider: "claude", model, startedAt: at, usage: { ...zeroUsage(), ...usage }, estimated: false, cacheSplit: true,
  speed: null, inferenceGeo: null, serviceTier: null, ...extra,
});
const close = (actual: number | null, expected: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
};
const M = 1_000_000;

// Expected values use the list prices on https://platform.claude.com/docs/en/about-claude/pricing
// and OpenAI's as carried by genai-prices, read 2026-10-15, in USD per million tokens.

test("Opus 5.5 has no long-context surcharge, even near 1M input", () => {
  const { cost, flags } = priceRequest(request("claude-opus-5-5", { input: 2_000, cacheRead: 950_000, cacheWrite: 16_000, output: 3_000 }));
  close(cost, (2_000 * 4 + 950_000 * 0.2 + 16_000 * 5 + 3_000 * 20) / M);
  assert.equal(flags, 0);
  assert.equal(findModel("claude", "claude-opus-5-5-20261001")?.id, "claude-opus-5-5", "dated snapshots match");
  assert.equal(findModel("claude", "Claude-Haiku-4-5-20251001")?.id, "claude-haiku-4-5", "matching ignores case");
});

test("Haiku 5.5 prices every token at the higher rate once total input passes 100k", () => {
  const usage = { input: 1_000, cacheRead: 90_000, cacheWrite: 9_000, output: 2_000 };
  close(priceRequest(request("claude-haiku-5-5", usage)).cost, (1_000 * 0.1 + 90_000 * 0.01 + 9_000 * 0.125 + 2_000 * 0.5) / M);
  const over = { ...usage, input: 1_001 };
  close(priceRequest(request("claude-haiku-5-5", over)).cost, (1_001 * 0.5 + 90_000 * 0.05 + 9_000 * 0.625 + 2_000 * 2.5) / M);
});

test("one-hour cache writes cost more; an unreported split is priced at five minutes and marked", () => {
  close(priceRequest(request("claude-opus-5-5", { cacheWrite: 1_000, cacheWrite1h: 400 })).cost, (600 * 5 + 400 * 8) / M);
  const unknown = priceRequest(request("claude-opus-5-5", { cacheWrite: 1_000 }, { cacheSplit: false }));
  close(unknown.cost, 1_000 * 5 / M);
  close(unknown.high, 1_000 * 8 / M);
  assert.equal(unknown.flags, COST_ESTIMATED_CACHE);
  const known = priceRequest(request("claude-opus-5-5", { cacheWrite: 1_000, cacheWrite1h: 400, output: 10 }));
  assert.equal(known.high, known.cost, "a known split has no range");
  assert.equal(priceRequest(request("claude-opus-5-5", { input: 10 }, { cacheSplit: false })).flags, 0, "no writes, nothing to estimate");
  assert.equal(priceRequest(request("claude-opus-5-5", { output: 10 }, { estimated: true })).flags, COST_ESTIMATED_OUTPUT);
});

test("fast mode, US-only inference and web searches", () => {
  const usage = { input: 1_000, cacheRead: 10_000, cacheWrite: 2_000, cacheWrite1h: 1_000, output: 500, webSearches: 3 };
  // Fast Opus 5.5 is $8/$40; caching multipliers stack: reads 0.05×, five-minute writes 1.25×, one-hour 2×.
  const fast = (1_000 * 8 + 10_000 * 0.4 + 1_000 * 10 + 1_000 * 16 + 500 * 40) / M + 3 * 10 / 1000;
  close(priceRequest(request("claude-opus-5-5", usage, { speed: "fast" })).cost, fast);
  close(priceRequest(request("claude-opus-5-5", usage, { speed: "fast", inferenceGeo: "us" })).cost, (fast - 0.03) * 1.1 + 0.03);
  close(priceRequest(request("claude-opus-5-5", usage, { speed: "standard", inferenceGeo: "global" })).cost,
    (1_000 * 4 + 10_000 * 0.2 + 1_000 * 5 + 1_000 * 8 + 500 * 20) / M + 0.03);
  assert.equal(priceRequest(request("claude-haiku-5-5", { input: 1 }, { speed: "fast" })).flags, COST_ESTIMATED_MODE, "no fast price for this model");
});

test("Codex: cached input, the 272k tier and service tiers", () => {
  const codex = (usage: Partial<UsageFigures>, serviceTier: string | null = null) =>
    priceRequest({ ...request("gpt-5.5-codex", usage), provider: "codex", cacheSplit: false, serviceTier });
  close(codex({ input: 20_000, cacheRead: 80_000, output: 4_000, reasoning: 1_000 }).cost, (20_000 * 5 + 80_000 * 0.5 + 4_000 * 30) / M);
  close(codex({ input: 22_001, cacheRead: 250_000, output: 4_000 }).cost, (22_001 * 10 + 250_000 * 1 + 4_000 * 45) / M);
  close(codex({ input: 1_000, output: 1_000 }, "priority").cost, (1_000 * 12.5 + 1_000 * 75) / M);
  close(codex({ input: 1_000, output: 1_000 }, "default").cost, (1_000 * 5 + 1_000 * 30) / M);
});

test("unknown models are unpriced, never free; dated price lists apply from their start", () => {
  assert.deepEqual(priceRequest(request("claude-unreleased-9", { input: 5 })), { cost: null, flags: COST_UNPRICED, high: null });
  assert.deepEqual(priceRequest({ ...request("x", { input: 5 }), model: null }), { cost: null, flags: COST_UNPRICED, high: null });
  assert.deepEqual(priceRequest({ ...request("x", {}), model: null }), { cost: 0, flags: 0, high: 0 }, "no tokens, nothing to price");
  const providers: PriceProvider[] = [{ id: "anthropic", models: [{ id: "m", match: { equals: "m" }, prices: [
    { prices: { input_mtok: 1, output_mtok: 2 } },
    { constraint: { start_date: "2026-10-01" }, prices: { input_mtok: 3, output_mtok: 6 } },
  ] }] }];
  close(priceRequest({ ...request("m", { input: M }), startedAt: Date.parse("2026-09-30T23:00:00Z") }, providers).cost, 1);
  close(priceRequest(request("m", { input: M }), providers).cost, 3);
});
