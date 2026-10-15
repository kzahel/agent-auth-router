# Cost estimates at API rates

Status: implemented (2026-10-15). The router shows what its traffic would cost
at the providers' published pay-as-you-go API prices. Subscription accounts are
not billed these amounts; the figures compare usage against API pricing.

## What is priced

Every account the router accepts is a subscription login: Claude accounts use
Claude Code's `claudeAiOauth` credential ([credentials](../src/credentials.ts))
and report five-hour and weekly quota windows. There is no per-session question
of API-key versus subscription billing; every figure is "at API rates".

Each finished request already stores the provider's own token counts:
uncached input, cache reads, cache writes and output (with reasoning as a
subset of output). Cost is those counts times the model's per-token prices. No
tokenizer is needed: the live characters-per-token output estimate only covers
a response while it streams, and the provider's count replaces it at the end.

## Price data

Prices come from [pydantic/genai-prices](https://github.com/pydantic/genai-prices)
(MIT), chosen after comparing it with pi's model registry, models.dev and
LiteLLM's price table on 2026-10-15. All four matched Anthropic's published
prices for the models in use; genai-prices was the only one with:

- an explicit one-hour cache-write price, tiered where the base price is;
- tiers applied to the whole request by total input, which is Anthropic's
  long-context rule;
- a per-model `prices_checked` date and links to the provider's pricing pages;
- dated price lists, so a price change applies from its start date;
- Anthropic and OpenAI coverage, including OpenAI service tiers.

The router has no runtime npm dependencies and the desktop bundle ships only
the compiled core, so the Anthropic and OpenAI sections of
`prices/new_data/v2/data.json` are vendored, trimmed to the fields the router
prices, into [src/prices-data.ts](../src/prices-data.ts) by
[scripts/update-prices.mjs](../scripts/update-prices.mjs) from the pinned
`genai-prices` reference checkout ([reference/README.md](../reference/README.md)).
The file records the source commit, its date and the MIT notice. To update:
move the `genai-prices` pin, `python3 scripts/references.py sync --only
genai-prices`, `node scripts/update-prices.mjs`, review the diff, and commit.
The router reprices stored history when the vendored commit changes.

## Rules

[src/pricing.ts](../src/pricing.ts) reproduces the genai-prices calculation for
the price fields in use:

- **Model match:** the provider section by provider (`claude` → `anthropic`,
  `codex` → `openai`), then the first model whose match rule (equals,
  starts_with, ends_with, contains, regex, and/or; case-insensitive except
  regex) accepts the reported model id.
- **Dated prices:** the latest price list whose `start_date` is on or before
  the request's start.
- **Tiers:** a tiered price picks the highest tier whose `start` is below the
  request's total input (uncached input + cache reads + cache writes), and
  that rate applies to every token of that type. As of 2026-10-15 Anthropic's
  only tiered model in use is Claude Haiku 5.5 (above 100k input tokens, every
  category costs 5×); Claude 4.6 and later models other than Haiku 5.5 have no
  long-context surcharge. OpenAI's GPT-5.x models tier above 272k.
- **Cache writes:** one-hour writes are a subset of cache writes. They take
  `cache_write_1h_mtok`; the rest take `cache_write_mtok` (five-minute).
- **Variants:** Codex responses report a `service_tier`; a price variant whose
  `when.service_tier` matches overrides the standard prices. Batch is not
  used by the routed clients.
- **Anthropic fast mode** (`usage.speed: "fast"`): genai-prices has no fast
  prices, so [src/pricing.ts](../src/pricing.ts) holds Anthropic's published
  fast rates (Opus 5.5 $8/$40, Opus 5 and Opus 4.8 $10/$50 per MTok input and
  output). Caching multipliers apply on top, so input-side categories scale by
  the fast/standard input ratio and output by the output ratio.
- **US-only inference** (`usage.inference_geo: "us"`): ×1.1 on every
  category, applied only when the response reports it.
- **Web searches** (`usage.server_tool_use.web_search_requests`):
  `web_searches_kcount` per thousand.

Source: <https://platform.claude.com/docs/en/about-claude/pricing> and
<https://platform.claude.com/docs/en/build-with-claude/fast-mode>, read
2026-10-15.

## Exact and estimated costs

A cost is exact when the provider reported everything it depends on. It is
marked estimated (`~`) when:

- the response did not report the five-minute/one-hour cache-write split.
  Requests recorded before 2026-10-15 stored only the total; their cache
  writes are priced at the five-minute rate, so a one-hour write is
  under-priced by 37.5% on Opus 5.5 ($5 instead of $8 per MTok);
- output is still the live estimate (a stream that ended without the
  provider's final count).

A request whose model has no price is unpriced: it counts toward "unpriced
requests", never as zero cost.

## Recording

The usage tap records, from Claude's `message_start` usage (the delta event
repeats totals without the split):

- `cache_creation.ephemeral_1h_input_tokens` as `cacheWrite1h`, a subset of
  `cacheWrite`, and whether the split was reported at all;
- `speed` and `inference_geo`;
- `server_tool_use.web_search_requests` (cumulative, also in the delta).

From Codex it records `service_tier`. All are metadata; no content is kept.

`history.db` schema version 2 adds these to the `requests` table, with
`cost_usd` and `cost_flags` computed when a request is stored. At startup the
router prices rows without a cost, and reprices every row when the vendored
price commit differs from the one recorded in the database.

## Display

- Requests and sessions tables: a Cost column, `~` when estimated.
- Chart legend: the total for the selected range and scope, "≈ $X at API
  rates", with the number of unpriced requests in its tooltip.
- Tooltips say the figures are API list prices, not what a subscription pays.

## Plan

1. Record the cache-write split, speed, inference geography, web searches and
   Codex service tier; schema migration to version 2. ✔
2. Pin genai-prices as a reference, vendor the trimmed data with provenance,
   and write the calculator with tests (Opus flat above 200k, Haiku 5.5 tier,
   one-hour writes, unknown split, fast mode, US-only, Codex tiers and service
   tier, unknown model). ✔
3. Price requests when stored; price or reprice history at startup. ✔
4. Range totals by scope from the stored requests; costs in the requests and
   sessions views. ✔
5. Check against live traffic: the share of cache writes that are one-hour in
   Claude Code subscription traffic. ✔ (see below)

## Findings

Recorded after the router ran with this change; see the end of this file.
