# Pool routing policies: research and proposed behavior

Research date: 2026-10-04. Status: discussion and implementation proposal, not
new runtime behavior. AAR currently implements **Manual** and **Round robin**.
This document records the maintainer's request to explore quota-aware policies,
especially using allowance before its weekly window resets.

## Existing documents and implementation

YA [tactical 143](https://github.com/kzahel/yepanywhere/blob/main/docs/tactical/143-agent-auth-router-integration.md#account-pools-policies-and-selection)
already lists Auto, Manual, Earliest reset, Most remaining and Round robin.
Its Earliest reset means the reset of the **most constrained applicable window**;
it does not specifically mean the weekly window. The
[YA topic](https://github.com/kzahel/yepanywhere/blob/main/topics/agent-auth-router.md#deferred-follow-ups)
and [desktop workstream](router-owned-pools-and-desktop.md#product-and-policy-follow-ups)
record advanced policies as follow-ups. Neither specifies a complete comparator.
Use this document for the detailed research and proposed semantics; AAR owns
selection, and YA consumes its metadata. The
[owner contract](owner-management.md) supersedes older integration-owned pools.

Source checked: [pool evidence](../src/pools.ts),
[allocator](../src/control.ts), [quota normalization](../src/quotas.ts) and
[pool fixtures](../test/pools.test.ts), at AAR commit
`95a765b` (no runtime edits in this research change).

- Manual chooses the requested permitted account. Unknown quota is allowed,
  but catalog validation, known exhaustion and observed auth/cooldown blocks
  still apply.
- Round robin first prefers the fewest unexpired prepared allocations in the
  pool, then membership order after its durable cursor. Commit advances the
  cursor once. This is rotation of **new session assignments**, not requests,
  token usage or active workers.
- Startup reservations last five minutes. They are shared across integrations
  using the same pool, but not across overlapping pools. Committed or historical
  bindings are not active-load measurements.
- Automatic admission requires fresh model/catalog and applicable quota
  evidence. Catalog freshness is 60 seconds; quota freshness is 120 seconds.
  Overview reads are passive; explicit refresh performs provider metadata I/O.
- Existing sessions retain their account on continuation, resume and restart.
  A new policy must not change this, replay work or enable paid overage.

## Reference implementations

These are source observations from pinned GitHub snapshots downloaded for this
review. Upstream applications and tests were not run. No upstream code was
copied; adopting code later requires preserving its license notices.

### CLIProxyAPI

Repository: [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/8ef43e4df3b216a42493105d31c2873b69191473),
revision `8ef43e4df3b216a42493105d31c2873b69191473` (main when queried).

The [selector factory](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/service_config.go)
and [configuration](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/config.example.yaml)
expose three built-in strategies:

| Strategy | Observed behavior | Lesson for AAR |
| --- | --- | --- |
| Round robin | Rotate eligible credentials by identity, scoped by provider/model; account for candidates disappearing between picks. | Keep deterministic identity-based ordering when eligibility changes. AAR's durable commit semantics remain separate. |
| Weighted round robin | Smooth weighted rotation using configured integer weights; non-positive weights exclude a credential. | Useful for owner-declared unequal shares; weights are not measured quota capacity. |
| Fill first | Repeatedly choose the first available credential in deterministic order. | A simple preferred-account policy, potentially useful for concentrating use and leaving backups untouched. It does not inspect weekly headroom. |

The [selector implementation](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/auth/selector.go)
filters availability, normally uses the highest available priority tier, and
sorts that tier by credential ID. Thus fill-first does not mean greatest
remaining quota or soonest reset. Smooth weighted selection adds each eligible
weight to its running credit, selects the largest credit and subtracts the sum
of eligible weights from the winner. The
[scheduler](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/auth/scheduler.go)
also has specialized ready queues for these strategies.

Its earliest cooldown/retry time is used when no candidate is available. That
is **when to retry**, not a strategy preferring usable weekly allowance about
to reset. No Most remaining or Soonest weekly reset built-in was found in the
factory, selectors, scheduler or routing configuration inspected here. This
does not rule out third-party plugins or forks.

Optional session affinity wraps the selector. It caches session associations
with a configurable TTL (default one hour), and permits reselection when the
bound credential becomes unavailable. AAR instead requires a durable session
pin and refuses silent switching. Copying the upstream affinity/failover
behavior would change AAR's continuation contract.

Relevant upstream fixtures, read but not executed:
[selector tests](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/auth/selector_test.go),
[scheduler tests](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/auth/scheduler_test.go),
[affinity priority tests](https://github.com/router-for-me/CLIProxyAPI/blob/8ef43e4df3b216a42493105d31c2873b69191473/sdk/cliproxy/auth/session_affinity_priority_test.go).

### VibeProxy

Repository: [automazeio/vibeproxy](https://github.com/automazeio/vibeproxy/tree/f2aa365523dd739a114fb7bc73a58353c3737c49),
revision `f2aa365523dd739a114fb7bc73a58353c3737c49` (main when queried).
Its [README](https://github.com/automazeio/vibeproxy/blob/f2aa365523dd739a114fb7bc73a58353c3737c49/README.md)
describes round-robin distribution and rate-limit failover, delegates the backend
to CLIProxyAPI, and documents persistent configuration overrides. Its
[settings UI](https://github.com/automazeio/vibeproxy/blob/f2aa365523dd739a114fb7bc73a58353c3737c49/src/Sources/SettingsView.swift)
labels that behavior; its
[configuration tests](https://github.com/automazeio/vibeproxy/blob/f2aa365523dd739a114fb7bc73a58353c3737c49/src/Tests/ConfigComposerTests.swift)
preserve round-robin configuration through merging. The inspected wrapper is not evidence of an
independent weekly-quota algorithm, nor proof that any particular installed
VibeProxy binary includes the CLIProxyAPI revision above.

## What are we optimizing?

There are several useful goals, and no single ordering satisfies them all:

| Goal | Candidate policy | Main tradeoff |
| --- | --- | --- |
| Spread new sessions evenly | Round robin, implemented | Equal session counts do not mean equal usage. |
| Give a new session the most relative breathing room | Most remaining | May leave allowance unused on an account resetting soon. |
| Use allowance before the weekly window renews | Soonest weekly reset | May concentrate long sessions on an account with little immediate headroom. |
| Prefer a particular work account, keep backups | Fill first / owner priority | Can crowd the preferred account; no quota optimization. |
| Allocate unequal shares to accounts | Weighted round robin | Requires explicit weights; different session sizes defeat token-level fairness. |
| Avoid concurrent contention | Least active work | Needs a meaningful live-work measure; historical pins and momentary HTTP request counts are insufficient. |
| Balance waste, headroom and contention | Auto, later | Needs explicit objectives, evidence and simulations before choosing a score. |

OAuth token expiry is a separate credential-lifecycle concern. Do not route to
the token expiring first. “Reset” here means the provider-reported quota window.
Do not promise that unused allowance rolls over or that every window is a fixed
calendar week; use observed timestamps, not a guessed Monday reset.

## Proposed first policies

Keep Round robin as the existing default. Add explicit **Most remaining** and
**Soonest weekly reset**, with the following deterministic behavior. Names and
IDs below are proposed, not currently accepted by the API.

### Shared admission and ordering

1. Resolve current pool/grant/account/model permission and common automatic
   eligibility before ranking. All known applicable windows must have usable
   evidence and positive headroom. One exhausted short or model-specific window
   disqualifies the account even when its weekly window looks attractive.
2. Derive policy inputs from one snapshot and one captured `now`. Preserve
   individual windows and observation times. Unknown is not 100% remaining;
   elapsed reset timestamps require new provider evidence, not a local refill.
3. For these first policies, retain the current startup-spreading rule: restrict
   ranking to eligible candidates with the fewest live prepared reservations
   **in this pool**, then compare quota scores. A burst may select a later reset
   to avoid stacking starts on the first account. Say this in selection reasons.
4. Break final ties using ordered membership after the durable pool cursor.
   Extend cursor advancement to these automatic policies on successful commit
   only. Repeated prepare/commit returns the persisted choice; commit rechecks
   admission but does not rerank. Cancel/expiry releases the reservation.

This deliberately preserves the existing limited scheduling signal. It does
not solve crowding from committed sessions, direct CLI activity or overlapping
pools. Router-wide account reservations are a separate improvement to evaluate;
do not describe pool-local reservations as global load balancing.

### Most remaining (`most-remaining`)

For each eligible account and requested model:

```text
headroom = minimum remainingPercent across all applicable reported windows
sort: headroom descending, then cursor order
```

The minimum is a conservative relative bottleneck heuristic, not an estimate
of remaining tokens. A 20% weekly allowance and 20% five-hour allowance can
represent very different amounts of work. Do not add percentages or treat
accounts on different plans as equal absolute capacity.

Example: A has short/weekly remaining of 80%/15%; B has 35%/60%. B wins
(35% versus 15%), even though A has more short-window headroom.

### Soonest weekly reset (`earliest-weekly-reset`)

Among eligible accounts, find the applicable weekly windows using verified
provider mapping and a reported/normalized duration of **10,080 minutes**.
Codex `primary` and `secondary` are positions, not duration names: a primary
window was observed to be weekly. Claude's current normalizer maps its known
`seven_day*` fields to weekly durations. Scope still determines applicability;
do not reinterpret an unknown limit ID as an account-wide entitlement.

```text
weeklyReset = minimum resetsAt across applicable weekly windows
sort: weeklyReset ascending, headroom descending, then cursor order
```

If several applicable weekly windows exist (general plus model-specific),
the earliest is the target; the others remain admission gates. Report the target
bucket explicitly. This is “an applicable weekly allowance resets soon,” not
“all limits clear then.” For equal reset times, greater overall headroom wins.

An account with no recognized weekly window is excluded from this policy with
a policy-specific reason, even if it is eligible for Round robin. If none have
usable weekly evidence, return an explanation and offer explicit Most remaining,
Round robin or Manual. Do not silently substitute a different algorithm.

### Why a generic Earliest reset is ambiguous

Consider equally unreserved accounts, with all evidence fresh and model-valid:

| Account | Short window remaining / reset | Weekly remaining / reset |
| --- | --- | --- |
| A | 20% / in 4 hours | 70% / in 1 hour |
| B | 30% / in 30 minutes | 50% / in 3 days |

- Most remaining chooses B: its minimum remaining is 30%, versus A's 20%.
- Soonest weekly reset chooses A: the weekly allowance resets in one hour.
- Earliest **any** reset chooses B because of its short window.
- Tactical 143's earliest **limiting-window** reset chooses B: both accounts'
  lowest percentages are in their short windows, and B's resets first.

These are distinct objectives. Do not ship one vague “Earliest reset” label.
If a limiting-window variant is added later, specify lowest remaining percentage,
then earliest timestamp and bucket ID to select a window when percentages tie.
That variant is not proposed for the first implementation.

If A has only 1% short-window headroom, Soonest weekly reset still chooses A
under these rules; it is not a promise a long session will fit. A headroom
reserve threshold could address that, but requires an explicit setting and
tests rather than an undocumented constant in the comparator.

## Later options worth retaining

- **Fill first:** owner membership order, first eligible account. Useful when
  work/personal preference matters more than balancing. Define any startup cap
  separately; a global least-reservations rule would change strict fill-first.
- **Weighted round robin:** owner-configured relative shares using a smooth
  weighted scheduler. Persist and test credits through prepare/commit/cancel,
  restart, membership edits and weight changes. Never infer plan weights from
  remaining percentages.
- **Reserve headroom:** an explicit admission threshold for future sessions,
  distinct from a balancing policy. It cannot reserve provider quota against
  outside usage or guarantee existing sessions finish.
- **Auto:** compare simple rules in a simulator before combining scores. One
  candidate urgency signal is weekly percentage remaining divided by time to
  reset, but it explodes near reset and ignores short-window constraints, plan
  size and demand. It needs a time floor, headroom gates, concurrency semantics
  and a versioned formula. No formula is approved here.
- **Least active work:** first define what counts as active, how it expires and
  survives disconnect/restart. Idle retained sessions must not consume a lease
  forever. Inference concurrency alone does not measure future session demand.

AAR allocates at session start. A session may continue across multiple resets,
so even perfect initial ranking cannot continuously harvest expiring allowance.
Cross-account continuation remains separate work, not an implicit feature of Auto.

## Metadata and UI contract to add

Expose the same policy metadata through the headless owner/integration APIs so
the desktop and YA can render it. Keep sensitive profile paths owner-only.

- Advertise supported policy IDs and versions via an additive capability.
  Existing `pools-v1` clients must not be assumed to understand new enum values.
  Unknown policies require upgrade guidance, never a Round robin label/fallback.
- Expose a read-only selection preview with eligibility reasons, applicable
  windows, bottleneck percentage, target weekly bucket/reset, reservation
  influence, observation times and deterministic ordering. Preview must not
  reserve or mutate the cursor; later prepare can legitimately choose differently.
- Persist the selected policy/version, essential ranking evidence and a concise
  reason with the binding. Current metadata's fixed `policyVersion: 1` and
  general reason are not yet a full stored ranking explanation.
- Example: “Weekly resets in 2 hours; 62% weekly left; 28% minimum headroom.”
  Continue showing percentage **remaining**, with 100% representing a full bar.
  Show missing/stale data explicitly rather than an apparently empty/full meter.

## Suggested implementation sequence and verification

1. **Evidence and comparators:** factor shared applicable-window projection and
   a pure selector with injected time; implement Most remaining first, then
   Soonest weekly reset. Keep the current conservative scope rules; extending
   provider/model mappings requires source evidence and fixtures of its own.
2. **Allocation and consumers:** add versioned policy discovery, persisted
   selection explanations, owner pool settings, desktop controls and YA contract
   handling together. Update AAR's SHA-pinned YA integration fixture after YA
   supports the additive policy contract. Do not change existing pool defaults.
3. **Refresh usability:** bounded/coalesced pool refresh and refresh at admission
   merit a companion slice. The current 60-second catalog limit means saved
   policies alone will not make automatic starts reliable after idle time.
   Specify deadlines, partial failure, rate-limit backoff and cancellation;
   recheck grants and model eligibility after asynchronous reads. This research
   does not enable background polling or refresh on passive overview reads.
4. **Compare before Auto:** simulate staggered/synchronized weekly resets,
   asymmetric short limits, unequal plans, long sessions and concurrent starts.
   Record session admissions, simulated unused allowance and starvation, while
   keeping modeled demand separate from real provider guarantees.

Before shipping, synthetic tests must cover:

- Opposing short/weekly rankings, multiple applicable weekly windows, a weekly
  Codex primary, unrelated Claude model windows, unknown scope, missing weekly
  data, exact ties and a single eligible account.
- Exhaustion in any applicable window; stale/missing/failed evidence; reset at
  `now`; elapsed reset without refill; clock skew; auth rejection and cooldown.
- Simultaneous prepare across integrations, ranking versus reservation order,
  cancel/timeout, duplicate responses, commit once, restart and persisted pins.
  Include overlapping pools to document the reservation boundary.
- Membership/grant/enablement changes between evidence read, prepare and commit;
  policy changes affecting only new allocations; same-account continuation and
  no cross-account retry after an ambiguous request.
- Headless/desktop/YA agreement on policy IDs, preview and selection reasons;
  old clients and unsupported policies; private-field redaction; both providers
  through the SHA-pinned integration suite.

This research changed documentation only. No provider credentials, live quota
reads, inference, router configuration or installed application were involved.
