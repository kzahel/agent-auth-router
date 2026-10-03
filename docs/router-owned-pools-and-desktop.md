# Router-owned pools, live accounts and desktop app

Status: implementation in progress on 2026-10-03. Router ownership, live
management, YA authority gates and the first Tauri app are implemented.
See [owner management](owner-management.md) and [desktop setup and acceptance](../desktop/README.md).
Signed GitHub candidate and installed upgrade acceptance remain separate gates;
this document does not authorize public release publication.

## Goal and correction

Install AAR, add and sign in to work accounts, create a Work pool, grant YA
access, and use that pool without terminal commands, service restarts or
re-pairing. Deliver a Mac menu-bar app first with a shared desktop stack that
can support Windows without replacing the UI.

The first implementation persisted pools in AAR but scoped ownership to an
integration. Pairing also captured a fixed account list, and credential
coordinators were created only at startup. These are implementation limitations
to correct before building the desktop UI around them.

This direction supersedes integration-owned pools and restart/re-pair enrollment
as the target design in YA tactical 143. The existing implementation and its
verified evidence remain accurately documented until the replacement lands.

## Ownership and authority

| Resource | Owner and intended behavior |
| --- | --- |
| Accounts and dedicated login profiles | AAR registers them; official provider CLIs own OAuth and credential storage. |
| Quota observations, pools, membership and policies | AAR owns one authoritative registry, independent of any client connection. |
| Integration identity and grants | AAR grants a named client permission to use selected pools. Use permission does not confer administration. |
| Session binding and inference credential | AAR manages a durable account pin associated with the requesting integration. |
| Desktop administration | The local owner manages AAR through an explicit owner administration surface. |
| YA | A client of AAR; lists permitted pools, requests allocations and renders permitted metadata. |

Create Work once, then grant YA permission to use Work. That grant follows the
pool's current membership: adding an account to Work is an explicit owner action
that makes it available to clients granted Work. Merely enrolling an account
leaves it unassigned; enrollment does not grant all clients access.

Pools remain single-provider in this slice. Separate Claude and Codex Work
pools are sufficient; a mixed-provider grouping UI is not a prerequisite.

Disconnecting or revoking YA invalidates that integration's grants and derived
credentials, while accounts and pools survive. Another authorized client may
continue using the same pool. Policy state and startup reservations belong to
the pool and arbitrate across all its authorized clients.

Use authority and management authority must be separate. The desktop owner
surface must not be simulated by copying YA's private token or by making every
paired integration an administrator. YA pool editing must be gated by explicit
administration authority or give way to selection and read-only metadata.
Define the exact owner bootstrap, grant operations and wire capability changes
before implementing them; do not silently broaden existing `pools-v1` meaning.

Existing sessions never rerun selection because accounts or pools change.
Retain current conservative revocation behavior: disabling/removing an account,
removing its pool membership, deleting the pool or revoking its grant blocks
subsequent unauthorized requests, with no account substitution. Already accepted
streams may finish. Show affected bindings before destructive changes.

## Live account and grant management

The running router owns durable mutations and the corresponding runtime changes.
Adding an account creates its coordinator without rebuilding other accounts or
interrupting their streams. Login/re-login updates the official credential store;
the router observes that account's new state without restart. Pool edits,
enable/disable operations and grants take effect without replacing the pairing.

Use one mutation authority for desktop and CLI operations. Avoid simultaneous
filesystem writers behind the live router. Offline administration must establish
exclusive ownership. Serialize and persist account/grant changes, invalidate
only affected metadata, recheck admission after asynchronous reads, and prevent
stale callbacks from reviving removed accounts or grants. Disabling or deleting
an enrollment must not erase the official credential store implicitly.

Guide official CLI login with a dedicated profile and controlled environment.
Provider authentication remains owned by the official CLI; browser consent or
other human login steps remain visible. The app should remove the need to type
commands. UI messages and progress contain safe metadata, never access/refresh
tokens, raw auth files or unfiltered CLI output. Provider CLI availability and
version requirements must be discovered and explained during onboarding.

This does not implement or establish durable OAuth renewal. Do not replace
failed official renewal with router-owned token exchange or credential copying.

## Desktop and platform boundaries

Use Tauri for the shared desktop shell and a small web UI, with a native tray
menu and an Accounts & Pools window. Keep the existing Node/TypeScript router
headless and independently runnable. Bundle a pinned Node runtime and compiled
router with the app; installation must not depend on a source checkout or the
user's development Node installation.

- Use [Machine Control](https://github.com/kzahel/machine-control/tree/main/desktop)
  as the operator-shell and native lifecycle reference.
- Use [Desktop Release Kit](https://github.com/kzahel/desktop-release-kit)
  for the update contract, release validators and installed acceptance patterns.
  It is an operational reference, not a product UI starter.
- Use [Lid Awake](https://github.com/kzahel/lid-awake) as the compact menu-bar UX
  reference. The chosen implementation stack is Tauri, rather than a Swift UI
  that would need replacement for Windows.

First UI: router status, account enrollment/login status, pool membership and
Manual/Round robin policies, integration grants, cached quota windows/reset
information, explicit usage refresh, launch-at-login and updates. Closing the
window keeps the tray and routing available. Define router ownership, safe
attachment to an existing router, explicit Quit/Stop behavior and update/relaunch
handling before shipping; never start a duplicate router or silently terminate
active inference during an update.

Keep transport and OS integrations behind platform adapters: private Unix IPC
on Mac/Linux and a secured Windows local transport (named pipes are the intended
candidate), credential-store access, process-tree cleanup, startup registration,
paths and packaging. Windows access controls must be tested rather than inferred
from Unix permissions. No privileged helper is required by the product model.
Mac-first release scope does not constitute Windows runtime support.

## Migration and compatibility

Upgrade existing state in place with an explicit new schema and recoverable,
idempotent migration. Preserve router identity, pool IDs, ordered membership,
policy/cursor state, allocation IDs, token hashes, cancellation records and
existing account pins. Convert each old owning integration's pool relationship
into an explicit grant without granting another client access. Revoked
integrations remain revoked. Preserve direct manual bindings and their existing
account grants. Do not merge pools merely because their names match.

The new target is pool-granted dynamic membership. During migration, prove that
initial accessible accounts do not widen; subsequent owner membership edits
have the intended pool-wide effect. Old-client administration must not acquire
new global powers accidentally. Perform YA's release-corpus compatibility review
and introduce explicit capability gates before changing its wire behavior.
Downgrade support remains out of scope; incompatible old writers must refuse
new state. Do not require users to recreate pools, log in again or abandon pins
as a shortcut for migration.

## Implementation sequence and acceptance

1. **Correct pool ownership and grants.** Implement the router-owned registry,
   explicit owner/use boundaries and migration. Test two integrations sharing a
   pool, unauthorized access, preserved pins, cross-client allocation, revocation
   and disconnect leaving the pool intact.
2. **Make enrollment and account changes live.** Add account lifecycle and grant
   mutation operations. Prove additions become usable without restart/re-pair,
   unassigned accounts remain unavailable, and concurrent login, refresh,
   disablement, removal and admission cannot bypass authorization or disturb
   unrelated active streams.
3. **Align YA and build the Tauri management app.** Update permitted pool
   discovery, selection and administration gating. Exercise the complete
   install/add/login/Work-pool/grant/YA-start flow with synthetic fixtures first.
   Extend AAR's SHA-pinned YA suite. Check real sequential typing during updates,
   account/pool changes from both surfaces, startup ownership and safe shutdown.
   Use isolated temporary profiles for separately authorized live login/inference
   validation; identify any remaining human-only consent steps.
4. **Ship a signed Mac candidate and validate upgrades.** Build with GitHub
   Actions, sign the app and bundled executable code, notarize/staple, verify
   Gatekeeper and package integrity, and distribute immutable GitHub artifacts.
   Adopt the shared update contract with AAR's own product identity, endpoint and
   updater key. Reuse publisher infrastructure through private CI configuration.
   Validate installation and an actual older signed build updating to a newer
   build, including matching app/core/runtime identity and retained state. A
   canary pass alone is not AAR acceptance. Publication is a deliberate release
   step after candidate acceptance.
5. **Complete Windows support.** Retain the shared UI/domain model; implement and
   prove Windows IPC authority, credentials, process lifecycle, startup behavior,
   signed packaging and installed updates. Add Windows to the product's verified
   release matrix only when its acceptance is complete.

## Deliberate deferrals

Most remaining, Earliest reset, combined Auto scoring, clone/helper inheritance,
cross-account continuation, durable renewal research and a separate browser-served
HTML dashboard remain outside this slice. Pool-wide refresh and refresh during
session admission remain recorded follow-ups; live enrollment is distinct from
background quota polling. Existing explicit usage refresh is enough for the
first desktop flow.

YA's [router topic](https://github.com/kzahel/yepanywhere/blob/main/topics/agent-auth-router.md)
remains its owning product contract; its
[deferred follow-ups](https://github.com/kzahel/yepanywhere/blob/main/topics/agent-auth-router.md#deferred-follow-ups)
retain the later candidates. This plan does not reprioritize unrelated YA work.

## Implementation evidence (2026-10-03)

- Schema-3 migration, distinct owner/use authority, shared pools and dynamic
  grants/accounts are covered by the core synthetic suite. It includes retained
  pins, no initial access for new pairings, revocation across two clients,
  stale-read invalidation, retirement and isolated/cancellable official login.
- The SHA-pinned YA suite passes all 10 cases for Claude and Codex, including
  account enrollment into an existing grant without restart or re-pairing,
  rotation, continuation, revocation and preserved pins after both servers restart.
- YA capability 116 exposes management and direct-account authority, preserves
  legacy-router editing, and hides pool-only accounts from standalone manual
  choices. Full YA checks and three focused desktop/phone browser cases pass.
- The first macOS bundle includes pinned Node 24.19.0 and compiled core code.
  Installed smoke with system Node removed from PATH proves startup, enrollment,
  retained core after shell exit, attachment and explicit idle stop.
- Local ARM64 app and DMG signing/notarization/stapling and Gatekeeper checks
  passed. This is a dirty-development-tree rehearsal, not a published release.
  The signed app also runs the isolated installed smoke successfully.
- GitHub candidate workflow, per-product updater key and product routing config
  are implemented. Candidate CI still needs the private certificate password.
  Production route registration, exact signed older-to-newer installed upgrade,
  Intel execution, human browser consent and Windows acceptance are not yet
  established by these tests. No public release is published by this workflow.
