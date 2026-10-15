// A request's estimated cost at published API prices, from the vendored
// genai-prices table (src/prices-data.ts). Subscription accounts are not billed
// these amounts. Rules and sources: docs/pricing.md.

import { COST_ESTIMATED_CACHE, COST_ESTIMATED_MODE, COST_ESTIMATED_OUTPUT, COST_UNPRICED, type RequestCost } from "./history.ts";
import { PRICE_PROVIDERS, PRICES_SOURCE } from "./prices-data.ts";
import type { Provider } from "./types.ts";
import type { UsageFigures } from "./usage.ts";

type Match =
  | { equals: string } | { starts_with: string } | { ends_with: string } | { contains: string } | { regex: string }
  | { or: Match[] } | { and: Match[] };
interface Tiered { base: number; tiers: { start: number; price: number }[] }
type PriceValue = number | Tiered;
export interface ModelPrices {
  input_mtok?: PriceValue;
  cache_read_mtok?: PriceValue;
  cache_write_mtok?: PriceValue;
  cache_write_1h_mtok?: PriceValue;
  output_mtok?: PriceValue;
  web_searches_kcount?: PriceValue;
}
export interface PriceModel {
  id: string;
  match: Match;
  prices: ModelPrices | { constraint?: { start_date: string }; prices: ModelPrices }[];
  price_variants?: { when: Record<string, string>; prices: ModelPrices; constraint?: { start_date: string } }[];
}
export interface PriceProvider { id: string; models: PriceModel[] }

/** Changes when stored costs must be recomputed: a new price table or new rules. */
export const PRICES_VERSION = `${PRICES_SOURCE.commit}:rules-4`;

/**
 * Anthropic's fast-mode list prices (USD per million tokens), which genai-prices
 * does not carry. Caching multipliers apply on top of them. Source:
 * https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing, read 2026-10-15.
 */
const ANTHROPIC_FAST: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 8, output: 40 },
  "claude-opus-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 10, output: 50 },
};
/** US-only inference (`inference_geo: "us"`) on Claude 4.6 and later, on every category. */
const ANTHROPIC_US_MULTIPLIER = 1.1;

export interface PricedRequest {
  provider: Provider;
  model: string | null;
  startedAt: number;
  usage: UsageFigures;
  /** Output includes a live estimate the provider never replaced. */
  estimated: boolean;
  cacheSplit: boolean;
  speed: string | null;
  inferenceGeo: string | null;
  serviceTier: string | null;
}

function matches(logic: Match, id: string): boolean {
  const text = id.toLowerCase();
  if ("or" in logic) return logic.or.some(clause => matches(clause, id));
  if ("and" in logic) return logic.and.every(clause => matches(clause, id));
  if ("equals" in logic) return text === logic.equals.toLowerCase();
  if ("starts_with" in logic) return text.startsWith(logic.starts_with.toLowerCase());
  if ("ends_with" in logic) return text.endsWith(logic.ends_with.toLowerCase());
  if ("contains" in logic) return text.includes(logic.contains.toLowerCase());
  return new RegExp(logic.regex).test(id);
}

export function findModel(provider: Provider, modelId: string, providers: PriceProvider[] = PRICE_PROVIDERS): PriceModel | undefined {
  const section = providers.find(p => p.id === (provider === "claude" ? "anthropic" : "openai"));
  return section?.models.find(m => matches(m.match, modelId));
}

const active = (constraint: { start_date: string } | undefined, at: number) => !constraint || at >= Date.parse(constraint.start_date);

/** Dated prices: the latest list in effect at `at`; then matching variants override. */
export function activePrices(model: PriceModel, at: number, context: Record<string, string> = {}): ModelPrices {
  let prices: ModelPrices;
  if (Array.isArray(model.prices)) {
    prices = model.prices[0]?.prices ?? {};
    for (const candidate of [...model.prices].reverse()) if (active(candidate.constraint, at)) { prices = candidate.prices; break; }
  } else prices = model.prices;
  const overrides: ModelPrices = {};
  for (const variant of model.price_variants ?? []) {
    if (!active(variant.constraint, at) || !Object.entries(variant.when).every(([key, value]) => context[key] === value)) continue;
    for (const [key, value] of Object.entries(variant.prices) as [keyof ModelPrices, PriceValue][]) overrides[key] ??= value;
  }
  return { ...prices, ...overrides };
}

/** Threshold ("cliff") tiers: the highest tier below the request's total input prices every token. */
const rate = (price: PriceValue, totalInput: number): number =>
  typeof price === "number" ? price : price.tiers.reduce((current, tier) => totalInput > tier.start ? tier.price : current, price.base);

export function priceRequest(r: PricedRequest, providers: PriceProvider[] = PRICE_PROVIDERS): RequestCost {
  // Nothing billable: model listings, and requests that failed before any tokens.
  const u0 = r.usage;
  if (!(u0.input + u0.cacheRead + u0.cacheWrite + u0.output + u0.webSearches)) return { cost: 0, flags: 0, low: 0 };
  const model = r.model ? findModel(r.provider, r.model, providers) : undefined;
  if (!model) return { cost: null, flags: COST_UNPRICED, low: null };
  const prices = activePrices(model, r.startedAt, r.serviceTier ? { service_tier: r.serviceTier } : {});
  if (prices.input_mtok === undefined || prices.output_mtok === undefined) return { cost: null, flags: COST_UNPRICED, low: null };
  const u = r.usage, totalInput = u.input + u.cacheRead + u.cacheWrite;
  let flags = 0;
  let inputSide = 1, outputSide = 1;
  if (r.provider === "claude" && r.speed === "fast") {
    const fast = ANTHROPIC_FAST[model.id];
    if (fast) { inputSide = fast.input / rate(prices.input_mtok, 0); outputSide = fast.output / rate(prices.output_mtok, 0); }
    else flags |= COST_ESTIMATED_MODE;
  }
  if (r.provider === "claude" && r.inferenceGeo === "us") { inputSide *= ANTHROPIC_US_MULTIPLIER; outputSide *= ANTHROPIC_US_MULTIPLIER; }
  const per = (price: PriceValue | undefined, tokens: number, scale: number) => tokens > 0 && price !== undefined ? rate(price, totalInput) * tokens * scale / 1e6 : 0;
  // A category without its own price is priced as its parent, as in genai-prices.
  const read = prices.cache_read_mtok ?? prices.input_mtok, write = prices.cache_write_mtok ?? prices.input_mtok;
  // Without the split, every cache write is priced as one-hour, as Claude Code's
  // recorded traffic has been; `low` keeps the five-minute alternative for audits.
  const hour = r.cacheSplit ? Math.min(u.cacheWrite1h, u.cacheWrite) : u.cacheWrite;
  if (!r.cacheSplit && u.cacheWrite > 0) flags |= COST_ESTIMATED_CACHE;
  if (r.estimated) flags |= COST_ESTIMATED_OUTPUT;
  const cost = per(prices.input_mtok, u.input, inputSide) + per(read, u.cacheRead, inputSide)
    + per(write, u.cacheWrite - hour, inputSide) + per(prices.cache_write_1h_mtok ?? write, hour, inputSide)
    + per(prices.output_mtok, u.output, outputSide)
    + (u.webSearches > 0 && prices.web_searches_kcount !== undefined ? rate(prices.web_searches_kcount, totalInput) * u.webSearches / 1000 : 0);
  const unknown = r.cacheSplit ? 0 : u.cacheWrite;
  const low = cost - per(prices.cache_write_1h_mtok ?? write, unknown, inputSide) + per(write, unknown, inputSide);
  return { cost, flags, low };
}
