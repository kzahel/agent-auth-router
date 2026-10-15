# Cost estimates at API rates

Status: implemented 2026-10-15. The router shows what its traffic would cost
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
  Requests recorded before 2026-10-15 12:13 (local) stored only the total.
  Their cache writes are priced as one-hour, which is what every Claude Code
  request recorded with the split has used so far (see Findings). The
  five-minute alternative is stored as `cost_low_usd` for audits ($5 versus
  $8 per MTok on Opus 5.5);
- output is still the live estimate (a stream that ended without the
  provider's final count).

A request with tokens whose model has no price is unpriced: it counts toward
"unpriced requests", never as zero cost. A request with no tokens at all (a
model listing, or a failure before generation) costs $0.

## Recording

The usage tap records, from Claude's `message_start` usage (the delta event
repeats totals without the split):

- `cache_creation.ephemeral_1h_input_tokens` as `cacheWrite1h`, a subset of
  `cacheWrite`, and whether the split was reported at all;
- `speed` and `inference_geo`;
- `server_tool_use.web_search_requests` (cumulative, also in the delta).

From Codex it records `service_tier`. All are metadata; no content is kept.

`history.db` schema version 2 adds these to the `requests` table, with
`cost_usd` and `cost_flags` computed when a request is stored. Version 4 has
`cost_low_usd`, the five-minute alternative above (version 3 briefly stored a
one-hour upper bound in `cost_high_usd`, renamed by the migration). An older database gains the columns
at startup. The router reprices every row when `PRICES_VERSION` (the vendored
price commit plus a rules version in [src/pricing.ts](../src/pricing.ts))
differs from the one recorded in the database, which includes the first start
after this change.

## Display

- Requests and sessions tables: a Cost column, `~` when estimated.
- Chart legend: the total for the selected range and scope, "$X at API
  rates", "≈ $X" when part of it is estimated; its tooltip counts estimated
  and unpriced requests.
- Tooltips say the figures are API list prices, not what a subscription pays.

## Plan

1. Record the cache-write split, speed, inference geography, web searches and
   Codex service tier; schema migrations to versions 2 to 4. ✔
2. Pin genai-prices as a reference, vendor the trimmed data with provenance,
   and write the calculator with tests (Opus flat above 200k, Haiku 5.5 tier,
   one-hour writes, unknown split, fast mode, US-only, Codex tiers and service
   tier, unknown model). ✔
3. Price requests when stored; price or reprice history at startup. ✔
4. Range totals by scope from the stored requests; costs in the requests and
   sessions views. ✔
5. Check against live traffic: the share of cache writes that are one-hour in
   Claude Code subscription traffic. Started; see Findings.

## Verification

- `test/pricing.test.ts` checks hand-computed costs from the published rates:
  Opus 5.5 flat near 1M input; Haiku 5.5 at exactly 100k (base) and just
  above (every category at the higher rate); one-hour and unreported cache
  splits; fast mode, US-only inference and web searches; GPT-5.5 Codex below
  and above 272k and its service tiers; unknown models; dated price lists.
- A differential run (not in the repository) priced 2,000 random usages
  across Opus 5.5, Haiku 5.5, Haiku 4.5, GPT-5.5 and GPT-5.3 Codex with both
  this calculator and `@pydantic/genai-prices` 0.1.13's `calcPrice`; every
  result agreed to floating-point precision.
- `test/metrics.test.ts` migrates a version 1 database, prices its history at
  startup, prices new requests with the split and does not reprice when the
  table is unchanged.

## Findings

Observed on the maintainer's router on 2026-10-15, from 12:13 local time,
when the split started being recorded:

- All 16 Opus 5.5 requests with cache writes in the first half hour wrote
  only one-hour cache entries (25,212 of 25,212 tokens). They came from one
  Claude Code session on one subscription account; no Haiku request with
  cache writes was seen yet. This supports, but does not establish, that
  Claude Code subscription traffic uses one-hour caching. The stored totals
  will settle it as more sessions and models are recorded:
  `SELECT model, sum(cache_write), sum(cache_write_1h) FROM requests WHERE
  cache_write_1h IS NOT NULL GROUP BY model`.
- `inference_geo` was `global` and `speed` absent on every request, so no
  US-only or fast-mode multiplier applied.
- Of the 14,139 requests stored when pricing began, 40.1M Opus 5.5 cache-write
  tokens have no recorded duration: $321 as one-hour (the stored cost), $200
  as five-minute (`cost_low_usd`). These requests leave with retention (30
  days by default).
- Over the 24 hours before pricing began, traffic would have cost about $414
  at API rates, mostly cache reads (1.2B tokens at $0.20 per MTok).

## Auditing estimates

Start here when asked to audit or tighten the cost estimates. Everything is
in `history.db` in the state directory (`~/.agent-auth-router` by default);
open it read-only, for example with `node:sqlite`
(`new DatabaseSync(path, { readOnly: true })`). It holds metadata only.

1. **Is one-hour still the right assumption for unsplit cache writes?**
   Compare durations where the split is known, by model, account and client:

   ```sql
   SELECT model, account_id, client, count(*) AS requests,
          sum(cache_write) AS writes, sum(cache_write_1h) AS writes_1h
   FROM requests WHERE cache_write_1h IS NOT NULL AND cache_write > 0
   GROUP BY model, account_id, client;
   ```

   If some traffic writes five-minute entries, the rule in `priceRequest`
   ([src/pricing.ts](../src/pricing.ts), the `hour` line) could use the
   observed share per model instead of assuming one-hour; bump the rules
   suffix of `PRICES_VERSION` so stored history is repriced.
2. **How much is still estimated?** `cost_flags & 1` marks an unknown
   cache-write duration, `& 2` an output estimate, `& 8` a fast-mode request
   without a known fast price; `cost_usd IS NULL` is unpriced (`& 4`).

   ```sql
   SELECT count(*), sum(cost_usd), sum(cost_low_usd) FROM requests WHERE cost_flags & 1;
   ```

   The difference of the two sums is the most the assumption can be off by.
   Once these rows pass retention, nothing in this category is estimated.
3. **Are the prices current?** Run `python3 scripts/references.py upstream
   --only genai-prices`. If the pin trails, move it, run
   `node scripts/update-prices.mjs` and review the diff of
   [src/prices-data.ts](../src/prices-data.ts); its header names the source
   commit. Check new models in the traffic are matched:
   `SELECT DISTINCT model FROM requests WHERE cost_usd IS NULL AND model IS NOT NULL`.
4. **Rules outside genai-prices:** fast-mode prices and the US-only
   multiplier live in [src/pricing.ts](../src/pricing.ts) with their source
   URL; recheck them against Anthropic's pricing page.
5. **Cross-check the calculator** against genai-prices' own `calcPrice`
   (npm `@pydantic/genai-prices`) as in Verification, on rows sampled from
   the database rather than random usages.
