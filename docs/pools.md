# Pools and quota overview

Current ownership and schema-3 behavior: [owner management](owner-management.md).
AAR owns single-provider pools; integrations receive use grants. Owner pool edits
and live enrollment require no restart or re-pairing. YA renders scoped metadata
and requests allocation; it cannot administer router-owned pools.

## Unified session discovery and thinking (2026-10-04)

The [unified selection plan](unified-session-selection.md) extends the unshipped router feature without a new compatibility gate. Authenticated POST `/v1/selection` with `provider` reads
current granted metadata and refreshes missing/stale catalogs for that provider.
It performs no quota reads or inference. Discovery is bounded to 256 visible
accounts, four catalog requests globally, a 12-second caller deadline and
per-account coalescing/failure backoff. Cancellation stops admitting queued
discovery work; shared provider reads retain their own bounded deadline. Grants
are rechecked after asynchronous reads. Ordinary overview remains passive.

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
`quota-inference-headers-v1` and `supportedPolicies`. Overview adds
`supportedPolicies`, `admissionRefresh`, an optional `quota.source` of `probe`
or `inference` per account, and per-candidate `evidence` (headroom, limiting
bucket IDs, reservation count, catalog and quota timestamps). Reads stay passive. Bindings persist `policyVersion`,
`selectionEvidence` and a human-readable reason before reply. Most remaining
prepare requires a `supportedPolicies` array containing `most-remaining`, even
when it is the pool default. An old client receives upgrade guidance before
provider I/O rather than silently running a policy it does not understand.
YA gates the policy with optional capability 117 and connected-router support.

Desktop pool editing exposes Most remaining; YA exposes its session selection and
cached headroom preview. Unknown/missing observations remain explicit. Model
catalog discovery can still require an initial explicit refresh. Whole-pool
refresh controls, weekly reset and task-aware Auto remain follow-ups in
[routing policies](routing-policies.md).

## Shared allocation behavior

Pools have a name, ordered unique account subset (at most 16), Manual, Round
robin or Most remaining default, and an optimistic revision. Owner pool membership edits change the accounts available through its use
grants. Removing members or deleting a pool blocks affected retained bindings;
policy/name changes affect future selection only. The overview reports affected
binding counts. Deleted pool IDs cannot be reused.

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

Round robin and Most remaining require an enabled, granted account, fresh catalog membership and
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
poolId/provider/model/tokenHash, optional policy and manual accountId, and
`supportedPolicies` for Most remaining).
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
