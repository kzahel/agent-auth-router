# Pools and quota overview

Current ownership and schema-3 behavior: [owner management](owner-management.md).
AAR owns single-provider pools; integrations receive use grants. Owner pool edits
and live enrollment require no restart or re-pairing. YA renders scoped metadata
and requests allocation; it cannot administer router-owned pools.

## Unified session discovery and thinking (2026-10-04)

The [unified selection plan](unified-session-selection.md) extends the unshipped router feature without a new compatibility gate. Authenticated POST `/v1/selection` with `provider` reads
current granted metadata and refreshes missing/stale catalogs for that provider.
It performs no inference. Discovery is bounded to 256 visible
accounts, four catalog requests globally, a 12-second caller deadline and
per-account coalescing/failure backoff. Cancellation stops admitting queued
discovery work; shared provider reads retain their own bounded deadline. Grants
are rechecked after asynchronous reads. Ordinary overview remains passive.
Since 2026-10-06 Claude discovery may also run the CLI usage probe; see
[Claude CLI model rows](#claude-cli-model-rows-2026-10-06).

Model rows retain provider-reported reasoning levels/defaults, adaptive-thinking
support and context size. Unknown capabilities remain unknown, never inferred
from a model's name. Codex's catalog shape was inspected at upstream revision
`06f82c123c6ed295f0ef19b5cbf49cf78bbc092e`; Claude's shape was inspected in YA's
installed Anthropic SDK model declarations. These are source observations, not
proof of every live account's capabilities.

Prepare accepts optional `thinking` (`auto`, `off`, or `on:low|medium|high|xhigh|max`).
Explicit effort requires matching account model evidence; YA's Max also accepts
native `ultra`. It participates in the durable allocation request identity, so
retries cannot change the requested settings or chosen account. Omitting the
field retains the previous protocol behavior. Pool policies still check quota
readiness independently of model/thinking compatibility. Existing pins retain
their allocation settings; YA validates deliberate subsequent setting changes
against the pinned account without rerunning pool selection.

## Most remaining and admission refresh (2026-10-04)

Policies are Manual, Round robin and **Most remaining**. The latter compares each
eligible account's minimum remaining percentage across applicable reported
windows, highest first. Automatic policies first prefer the fewest unexpired
startup reservations within the pool; ties follow membership order after its
durable cursor. Commit advances the cursor once. These are relative percentages,
not estimates of remaining tokens or promises a session will fit.

New automatic admission refreshes missing/stale/failed evidence and windows whose
reset has passed. Fresh evidence is reused. Up to four account metadata reads run
at once across admission/overview refresh callers, coalesced per account. A pool
has at most 16 members, and admission has a 12-second deadline. Failed account
reads exclude that account while successful candidates remain usable. Existing
Retry-After backoff and auth/rate-limit blocks apply; no idle polling is added.
An elapsed reset is never a fabricated refill. Cancellation stops queued work and
prevents a late pin; shared in-flight reads finish within their provider deadlines.
Grants, pool revision, enabled state and eligibility are rechecked before admission.
Existing committed pins bypass selection and quota refresh on resume/restart.

`/v1/info` advertises `most-remaining-v1`, `admission-refresh-v1`,
`quota-inference-headers-v1`, `catalog-cli-models-v1` and `supportedPolicies`.
Overview adds `supportedPolicies`, `admissionRefresh`, an optional
`quota.source` of `probe` or `inference` per account, optional Claude
`cliModels`/`cliModelsAt`, and per-candidate `evidence` (headroom, limiting
bucket IDs, reservation count, catalog and quota timestamps). Reads stay passive. Bindings persist `policyVersion`,
`selectionEvidence` and a human-readable reason before reply. Until
2026-10-11 Most remaining prepare also required a `supportedPolicies` array
containing `most-remaining`; [default policy and per-session
choice](#default-policy-and-per-session-choice-2026-10-11) removed that gate.

Desktop pool editing exposes Most remaining; YA exposes its session selection and
cached headroom preview. Unknown/missing observations remain explicit. Model
catalog discovery can still require an initial explicit refresh. Whole-pool
refresh controls, weekly reset and task-aware Auto remain follow-ups in
[routing policies](routing-policies.md).

## Weekly pace (2026-10-11)

Capability `weekly-pace-v1`, policy `weekly-pace`. It aims to use weekly
allowance before it resets and to stay off accounts whose five-hour window is
nearly full. After the shared eligibility checks and the fewest-startup-
reservations rule, candidates are ordered by:

1. **Weekly timer not started.** An applicable weekly window (10,080 minutes)
   at 0% used with no reset time ranks first, so the next session starts its
   timer. This tier outranks the short-window reserve.
2. **Short-window reserve.** Accounts whose tightest applicable window shorter
   than a week has at least `SHORT_RESERVE_PERCENT` (30%) remaining rank ahead
   of those below it. If every candidate is below, the most short-window
   headroom wins. An account with no short window keeps the reserve.
3. **Weekly pace.** `share of the week elapsed × 100 − percent used`, the
   lowest across the account's started applicable weekly windows, highest
   first. Positive means behind pace: allowance that would otherwise go unused
   at reset. An account with no started weekly window ranks last.
4. Membership order after the durable cursor.

Windows are classified by duration, so Codex `primary`/`secondary` positions do
not matter. The 30% reserve is a fixed constant of policy version 1, chosen
from about five days of hourly dashboard metrics (the largest one-hour rise in
a five-hour window was about 35 points); it is not a per-pool setting yet.
Evidence gains `shortHeadroomPercent`, `weeklyUnstarted` and
`weeklyPacePercent`, and the persisted reason names the deciding tier.

Limits: selection happens only at session start, so a long session can still
fill its account's five-hour window. The jump start assumes a weekly window
begins at its first use; the hourly metrics fit that (the three accounts reset
at different hours) but do not prove it. The event log can confirm it. The
router never sends its own request to start a timer. Percentages are compared
as if accounts had equal plans.

## Default policy and per-session choice (2026-10-11)

A pool's policy is its **default**. Any consumer granted the pool may override
it for one allocation: prepare's `policy` accepts any router policy, and
`policy: "manual"` with `accountId` picks any member, whatever the default.
Pins, idempotency and commit behave as before; the request identity includes
the override.

- **No client policy list.** Prepare no longer requires `supportedPolicies`
  to name Most remaining or Weekly pace. A consumer can offer every policy
  the router lists without knowing it; the cost is that an older consumer may
  receive a policy id it has no label for.
- **Labels.** The overview, selection response and `/v1/info` return
  `policies`, each `{ id, label }` with an English display name, alongside
  the existing `supportedPolicies` ids.
- **Manual admission refresh.** A Manual prepare refreshes a stale catalog for
  its one account (no usage probe; Manual needs no quota evidence), so a pick
  made more than 60 seconds after discovery does not fail on a stale catalog.
- **Desktop.** The pool form says "Default policy" and has **Available to**
  checkboxes for connected integrations, which write the same grant as
  **Manage access**.

## Pool-backed gateway tokens (2026-10-12)

A gateway client may name a pool per provider instead of an account
(`aar client add NAME --claude-pool POOL`, by id or name; `clients/add` takes
`pools: { claude: <pool id> }`, and rejects an account and a pool for the same
provider). It suits clients that cannot run the integration protocol, such as
the PR review worker's Claude Code containers, which hold one static token.

- **Session.** The router reads the client's own session id: Claude Code
  2.1.291 sends `x-claude-code-session-id` and repeats it in
  `metadata.user_id`, now a JSON string; Codex sends `session_id`. The id is
  unauthenticated, but it can only move a client between accounts its pool
  already grants.
- **Selection.** A session's first request runs the same admission refresh and
  ranking as `pools/prepare`, with the pool's default policy and the request's
  `model`. The pick is pinned in `control.json` for seven days (at most
  10,000 pins), advances the pool cursor, and is logged as a `binding` event
  with action `session` and every candidate's evidence.
- **Spread.** A pin made within the five-minute prepare window counts as a
  startup reservation, so sessions that start together go to different members
  even before their traffic moves the quota evidence.
- **Affinity.** A pinned session keeps its account while the account stays in
  the pool and enabled, even when its quota runs low or it is rate limited. It
  moves only when the account leaves the pool or is disabled.
- **No session.** A request that names no session is chosen individually and
  never pinned; one without a model, such as `GET /v1/models`, takes the first
  enabled member. A deleted pool answers 403, and no eligible member 503.

## Shared allocation behavior

Pools have a name, ordered unique account subset (at most 16), Manual, Round
robin, Most remaining or Weekly pace default, and an optimistic revision. Owner pool membership edits change the accounts available through its use
grants. Removing members or deleting a pool blocks affected retained bindings;
policy/name changes affect future selection only. The overview reports affected
binding counts. Deleted pool IDs cannot be reused.

## Claude CLI model rows (2026-10-06)

Capability `catalog-cli-models-v1`. The usage probe's `initialize` reply
already carries the official CLI's own model list: the `--model` value (often
an alias), display name, description, `resolvedModel`, effort levels and
fast/auto/adaptive flags. The router keeps those rows per account as
`cliModels`, with `cliModelsAt`, on overview, selection and catalog responses.
Rows are recorded only after the CLI reports a signed-in subscription login,
even when the usage read that follows fails. They are bounded to 64 rows,
200-character names and ids, 300-character descriptions and the known effort
vocabulary; unknown fields are dropped.

An explicit account refresh records them from its quota probe. Claude
`/v1/selection` discovery runs that probe when an account's rows are missing or
older than one hour, and records the probe's quota as well. A failed read keeps
the last rows and retries after five minutes. This is a CLI process start, not
inference. Codex has no equivalent yet.

The rows are display and alias metadata. Admission and eligibility remain
keyed on exact catalog ids; a consumer translates an alias to its
`resolvedModel` before preparing a binding. `resolvedModel` is what the CLI
reports for that profile, not a verified statement of what the provider serves.

Overview reads perform no provider I/O. Explicit account refresh coalesces quota
and catalog reads, retains the last successful windows after a failed attempt,
and exposes the failure and observation time. Evidence expires after 60 seconds
(catalog) / 120 seconds (quota). Restart starts with unknown evidence.

Since 2026-10-05 every successful proxied inference response is also quota
evidence (`quota-inference-headers-v1`). The listener hands the upstream
headers to the evidence store, which records Claude's unified five-hour and
seven-day windows (utilization fraction and epoch reset) and Codex's primary
and secondary windows, stamps the snapshot `source: "inference"` at the
response time, and keeps any probed bucket the headers do not carry, such as
Claude's Opus and Sonnet weeklies. A 2xx also clears an earlier rejection
cooldown and a failed quota probe, because the credential has just worked;
catalog failures stay. Probe results carry `source: "probe"`. Non-2xx responses
only feed the existing rejection path. This makes a recently used account
fresh for automatic admission without a probe; an idle account still needs
one. Codex header names come from source inspection and are unverified live. A reset
passing never fabricates restored capacity. Refresh concurrency is bounded.
Unknown model scope blocks automatic admission; it is never inferred from a
quota percentage. Claude's explicit Opus/Sonnet windows apply to their model
families; unknown Codex limit IDs remain unknown rather than model entitlements.
Claude's `extra_usage` paid-overage credit meter is not recorded as a quota
window. A window reporting 0% used with no reset time has not started; that is
observed full headroom, while a used window without a reset time stays
unverified.

Automatic policies require an enabled, granted account, fresh catalog membership and
fresh applicable quota evidence with headroom and future resets. Manual can
proceed without quota evidence, but cannot ignore a known applicable exhausted
window or failed model validation. Fresh metadata is evidence, not a guarantee
that inference will succeed. No paid overage is enabled.

Selection and prepare persistence are one synchronous registry transaction.
Unexpired prepared bindings provide bounded startup reservations; ties use the
pool's durable commit cursor and stored membership order. Commit advances the
cursor once; repeat prepare/commit retains the same selection. Cancel/expiry
releases a startup reservation without erasing the pin. Reservations are not
quota debits, active-worker counts, or leases requiring YA heartbeats.

The selection request, chosen account, policy version/reason and observation
metadata survive lost responses and restart. Existing sessions never rerun a
policy. Concurrent edits, disablement or revocation are rechecked before
admission/commit. Inference authorization also enforces current pool membership.

Synthetic engine tests cover quota scopes/freshness, concurrent allocation,
retry/cancellation boundaries, pool ownership/edits and the authenticated HTTP
overview. YA browser coverage checks desktop/phone rendering and sequential
typing under concurrent updates. The SHA-pinned integration suite exercises
parallel pool launches, cold Most remaining admission, same-pin restart/resume,
exhaustion and pool deletion through both native provider adapters. Verification
on 2026-10-04 passed 99 core tests, 3 desktop tests and all 12 SHA-pinned
integration/tripwire tests. These use synthetic credentials and upstreams.

## Control API

`pools-v1` is an additive `/v1/info` capability. Authenticated owner-socket
owner mutations are POST `/v1/owner/pools/save` (id/name/provider/accountIds/policy/revision)
and `/v1/owner/pools/remove` (id/revision). Integration use operations include
`/v1/overview` (optional poolId/model/policy),
`/v1/overview/refresh` (accountId), and `/v1/pools/prepare` (allocation UUID,
poolId/provider/model/tokenHash, optional policy and manual accountId).
Save uses revision 0 for creation and the current revision for updates/deletion.
Existing binding commit/cancel/inspect operations also handle pool allocations.

Cancelling an allocation whose prepare was rejected or whose response was lost
records a scoped terminal cancellation. A later prepare cannot revive it.
Upstream 401/403/429 observations block new pool admission until a successful
explicit or admission refresh after the bounded retry period. In-flight observations cannot
erase a newer rejection. These observations are memory-only; restart discards
them and automatic admission requires new evidence. Manual is an explicit
unknown-quota override, not an authentication bypass.

Control storage upgrades version 1 to version 2 in place, preserving manual
pins and grants. Older AAR versions refuse version 2 rather than ignoring pool
authorization. Downgrading routed state is unsupported.

## Deferred follow-ups

Research resumed on 2026-10-04 in [routing policies](routing-policies.md): pinned
CLIProxyAPI/VibeProxy observations, Most remaining and Soonest weekly reset
proposals, explicit window/tie/reservation semantics and a verification plan.
Most remaining and admission refresh are now implemented as described above;
the remaining candidates are discussion, not shipped policy support.

The maintainer deferred further extensions on 2026-10-03. The YA owning topic
records [pool refresh/admission, Most remaining, and clone/helper inheritance](https://github.com/kzahel/yepanywhere/blob/main/topics/agent-auth-router.md#deferred-follow-ups)
as candidates for this workstream, with motivation, boundaries and a suggested
sequence. That section is the follow-up register; these are not scheduled work
or changes to the implemented contract above.
