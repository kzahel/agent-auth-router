# Unified session selection in Yep Anywhere

Status: implemented and verified in both repositories, 2026-10-04. This document owns
the cross-repository plan. YA's `topics/agent-auth-router.md` owns its current UX
contract. This supersedes the initial separate router model/default-thinking UI.

## User experience

Keep YA's ordinary Provider, Model and Thinking controls, their preferences and
their selected values. Add one optional Pool selector with Direct login as the
unrouted choice. A granted pool is compatible when at least one enabled member
supports the selected concrete model and thinking setting. Selecting a pool
never silently changes the model, effort, or authentication destination.

Use the router-owned pool policy by default. Only multi-member Manual pools need
an account choice; single-member Manual pools resolve that member. Keep UUIDs,
policy overrides, per-account refresh buttons and eligibility explanations out
of the ordinary launch flow. Settings retains diagnostics. An unavailable
selected pool stays selected with one actionable error, never direct fallback.

## Model and thinking contract

AAR publishes normalized, account-scoped model capabilities: supported native
reasoning efforts, default effort, adaptive-thinking support, context size and
capability provenance when available. Preserve explicit upstream capabilities;
unknown must not become an invented entitlement. Known provider/adapter model
metadata can fill gaps in YA without consulting the user's direct account.

YA combines AAR account availability with native adapter support into the same
model metadata used by normal controls. Resolve aliases before admission.
Implemented in the router on 2026-10-06: Claude accounts report the CLI's own
alias rows with `resolvedModel` (`catalog-cli-models-v1`, see
[pools](pools.md#claude-cli-model-rows-2026-10-06)), so YA can resolve an alias
from the account's CLI instead of guessing by model family. YA does not consume
it yet.
Explicit thinking is carried to allocation, checked against candidate models,
and passed unchanged through session persistence and provider launch. Native
effort mappings (including Codex Max/ultra and Off) use the selected account's
catalog, not a global direct-account cache. Resume retains the pin; deliberate
model/effort changes are validated against that pinned account.

## Demand-driven discovery

On New Session mount, provider changes, return to the visible form and connection
changes, YA requests current scoped pools and model metadata through its server.
Model/thinking changes recompute compatibility. Share concurrent work, retain
cached content while checking, ignore late results for previous hosts/providers,
and never block prompt typing. Missing/stale catalogs refresh automatically with
bounded concurrency, deadlines and failure backoff. No idle polling or inference
probes. Final admission refreshes quota evidence and rechecks grants, pool
membership, requested settings and eligibility before committing a pin.

Compatibility and quota readiness are separate: stale usage is a reason to
check, not proof that a model or pool is unsupported. Errors expose one action;
normal successful paths need no explanatory paragraphs or refresh buttons.

## Compatibility and ownership

The maintainer clarified on 2026-10-04 that this integration is unshipped and
both repositories update together. Use YA's existing overall router capability;
do not add another capability or a parallel legacy launch UI. Existing released
servers without the overall feature still receive no router requests. This
explicit decision supersedes the initially proposed per-slice compatibility
review and gate for this work.

Only granted pool/account metadata crosses control. The browser talks to YA,
never AAR. AAR owns credential reads, provider discovery and allocation; YA owns
native launch settings and presentation. No credential copying or OAuth changes.
Remote executors, constrained sandboxes, helper/clone inheritance and Windows
transport remain outside this change; existing refusal boundaries stay intact.

## Implementation and verification

1. Commit this plan, then implement bounded AAR discovery, normalized catalogs
   and thinking-aware admission with synthetic security/lifecycle regressions.
2. Implement YA discovery/projection and account-scoped adapter effort handling;
   preserve explicit settings across launch, first send, continuation and resume.
3. Replace the ordinary launch router panel with compatible pool selection and
   reuse the existing model/thinking controls. Use the existing overall feature gate.
4. Verify unit/API behavior, rapid source/provider changes, external grants,
   failures and old-server fallback; exercise desktop/phone layouts and actual
   sequential typing under concurrent metadata updates.
5. Commit YA and update AAR's immutable YA integration pin. Verify both native
   adapters with synthetic upstreams and temporary YA/profile directories,
   including selected effort on initial launch and same-account resume. Record
   exact checks and distinguish synthetic proof from live provider observations.

Commit directly on current branches in both repositories; preserve unrelated
concurrent work. AAR desktop packaging must include the new core before claiming
the installed application supports the new UX. Updating/restarting the user's
active YA process is a separate operational step and must preserve live sessions.

## Implementation evidence

2026-10-04: AAR catalog capabilities, bounded catalog-only discovery and
thinking-aware prepare/commit are implemented. `npm run check` passes all 121
core tests. YA commit `fb2c5b1ffac1c6c4a756effe858cef69c8976f3b` implements the
unified launch controls, automatic discovery, scoped native catalogs and thinking
validation. YA's full test suite, lint, format check and type check passed. One
unrelated service-worker timing test failed in the first full run, then passed
both in isolation and in the full rerun without changes to that test.

Desktop 1000×600 and phone 375×812 selector captures were inspected. The browser
fixture retained all 32 sequential prompt keystrokes during discovery; maximum
measured update latency was 7.1 ms. Component tests cover the actual New Session
form's retained model/thinking selection, alias resolution, manual pools,
incompatible/revoked selections and source/provider changes.

All 12 cross-repository tests pass against that immutable YA pin in temporary
profiles. Both native adapters receive explicit High and retain it after
restart/resume. Pool launches exercise catalog-only discovery, use the pool's
default policy without a YA override, and map explicit Max to Claude `max` or
Codex `ultra` using the allocated account's metadata. Native Codex unit tests also
cover scoped one-turn modifiers and restoring normal effort.

These are synthetic CLI/upstream tests, not new live-provider observations.
Commits are local; the clean pinned fixture was seeded from the local YA commit
with its original GitHub origin retained. Publish YA before AAR when pushing
these commits so CI can fetch the new pin. No installed app replacement or active
YA restart has been performed; the installed desktop must be rebuilt with this
core and YA restarted before the new UX is available in the running applications.
