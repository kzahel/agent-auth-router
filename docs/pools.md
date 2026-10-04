# Pools and quota overview

Current ownership and schema-3 behavior: [owner management](owner-management.md).
Router pools are now owner-managed; integration-scoped editing and pairing-time
account snapshots below describe the legacy contract only.

AAR engine and YA integration implemented 2026-10-03.

The agreed [router ownership and desktop plan](router-owned-pools-and-desktop.md)
replaces integration-owned pools and restart/re-pair enrollment as the target
architecture. That correction is not implemented yet; this document describes
the current behavior.

AAR owns integration-scoped, single-provider pools and the same eligibility
projection used by its metadata overview and allocator. YA renders that overview
and exposes explicit pool edits and refresh. No independent HTTP dashboard,
background polling, OAuth change, load-aware Auto, or cross-account replay is
part of this slice.

Pools have a name, ordered unique account subset (at most 16), Manual or Round
robin default, and an optimistic revision. Pool edits cannot widen pairing
grants. Removing members or deleting a pool blocks affected retained bindings;
policy/name changes affect future selection only. The overview reports affected
binding counts. Deleted pool IDs cannot be reused.

Overview reads perform no provider I/O. Explicit account refresh coalesces quota
and catalog reads, retains the last successful windows after a failed attempt,
and exposes the failure and observation time. Evidence expires after 60 seconds
(catalog) / 120 seconds (quota). Restart starts with unknown evidence. A reset
passing never fabricates restored capacity. Refresh concurrency is bounded.
Unknown model scope blocks automatic admission; it is never inferred from a
quota percentage. Claude's explicit Opus/Sonnet windows apply to their model
families; unknown Codex limit IDs remain unknown rather than model entitlements.

Round robin requires an enabled, granted account, fresh catalog membership and
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
parallel pool launches, same-pin restart/resume, exhaustion and pool deletion
through both native provider adapters.

## Control API

`pools-v1` is an additive `/v1/info` capability. Authenticated owner-socket
operations are POST `/v1/pools/save` (id/name/provider/accountIds/policy/revision),
`/v1/pools/remove` (id/revision), `/v1/overview` (optional poolId/model/policy),
`/v1/overview/refresh` (accountId), and `/v1/pools/prepare` (allocation UUID,
poolId/provider/model/tokenHash, optional policy and manual accountId).
Save uses revision 0 for creation and the current revision for updates/deletion.
Existing binding commit/cancel/inspect operations also handle pool allocations.

Cancelling an allocation whose prepare was rejected or whose response was lost
records a scoped terminal cancellation. A later prepare cannot revive it.
Upstream 401/403/429 observations block new pool admission until a successful
explicit refresh after the bounded retry period. In-flight observations cannot
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
Only Manual and Round robin are implemented; the new document records discussion,
not shipped policy support.

The maintainer deferred further extensions on 2026-10-03. The YA owning topic
records [pool refresh/admission, Most remaining, and clone/helper inheritance](https://github.com/kzahel/yepanywhere/blob/main/topics/agent-auth-router.md#deferred-follow-ups)
as candidates for this workstream, with motivation, boundaries and a suggested
sequence. That section is the follow-up register; these are not scheduled work
or changes to the implemented contract above.
