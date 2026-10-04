# Router ownership and live administration

AAR owns accounts, pools, ordered membership, policy and allocation cursors.
Integrations own only scoped use grants. Pairing creates an identity with no
account or pool access. An owner grant follows the current pool membership;
adding an account alone grants nothing. Disconnecting an integration revokes
its pins without deleting pools or affecting other clients. Round-robin startup
reservations and the committed cursor are shared across authorized clients.

## Authority

The existing private `control.sock` serves both protocol namespaces. It requires
an owner-only state directory, a mode-0600 socket, `Host: localhost` and no
browser Origin. `/v1/owner/*` additionally requires the distinct random
`aar_owner_…` credential in mode-0600 `owner.key`. Integration `aar_ctl_…`
credentials cannot administer. Neither token type can infer. This is an
explicit API authority boundary, not a sandbox against the same OS user.

The desktop's native bridge and CLI read the owner key; the web view receives
metadata only in the management window. A separate embedded sign-in window can
receive ephemeral CLI output through its own native PTY bridge. Owner POST
operations include `overview`, `providers`,
`profiles/discover`, `profiles/inspect`, `accounts/add`, `accounts/set-nickname`, `accounts/set-enabled`, `accounts/retire` (legacy), `accounts/removal-preview`, `accounts/remove`, `accounts/login`,
`accounts/login-status`, `accounts/open-login`, `accounts/cancel-login`,
`accounts/refresh`, `accounts/renew`, `pools/save`, `pools/remove`,
`grants/save`, `integrations/revoke`, `clients/add`, `clients/revoke`, and `stop`.
Owner account metadata includes the absolute profile folder, optional nickname and
credential storage kind. Integration metadata does not expose these local details.
Account IDs are stable and generated when omitted; nickname edits use the account
revision and never change profile identity. Empty nicknames remove the label.

The desktop opens the bundled `terminal-login <id>` CLI in macOS Terminal or
a separate embedded xterm.js window, chosen at runtime in App settings. Both
use the same core login lease. The native PTY bridge binds input, output and resize
to the calling sign-in window, which cannot invoke management commands. It has
a 256 KiB unread-output ceiling, 4 KiB input-message bound and a disconnect
watchdog; output is never persisted. Closing the window cancels the process
group, with bounded escalation and draining to avoid stalled terminal writers.
Internal owner-only `accounts/terminal-begin`, `accounts/terminal-attach`,
`accounts/terminal-status` and `accounts/terminal-end` operations track the runner
and its official CLI process under a per-login nonce. These endpoints, process
IDs and nonce are never exposed to the web view or integrators. The core holds
the renewal/lifecycle exclusion until the child has exited, cancels on runner
loss or a ten-minute deadline, and escalates termination after three seconds.
The earlier headless `accounts/login` API remains available to CLI callers.

All use bounded JSON bodies and the same running mutation authority.

`aar owner <operation>` reads JSON from stdin. It contacts the running router,
or temporarily starts the core when offline. Interactive `accounts/login`
requires `aar serve` or the desktop app to keep its CLI process alive.
Socket binding serializes writers;
headless startup refuses occupied endpoints. Desktop startup can quarantine a
private socket after repeated connection refusal and unchanged inode checks. `account add`, client mutation and renewal
also use this authority. There is no owner API on the inference HTTP listener.
Account addition supports a stable ID, provider and optional dedicated home,
credential-store choice and supported official helper. The desktop creates its
profile under the private state directory. No arbitrary helper argv is accepted
through enrollment. New coordinators join the live map without rebuilding peers.

Existing-profile enrollment (2026-10-04) is explicit: `accounts/add` with
`enrollment: "existing"` requires a folder and inspects its supported credential
store and direct-provider configuration before registering it. It never creates
configuration or credential files or changes folder permissions. Discovery lists
only normal/environment profile directories, without reading credentials. Owner
inspection returns sanitized status/expiry; it does not contact the provider or
prove live access. Existing Codex non-file stores are refused without migration,
even if an old `auth.json` remains. File-store and provider endpoint overrides
must match the supported router contract.

On macOS, Claude's normal `~/.claude` profile can explicitly use
`claude-keychain-default`, selecting only `Claude Code-credentials` and leaving
`CLAUDE_CONFIG_DIR` unset for official login. `claude-keychain` retains the
profile-derived service for explicitly set configuration directories, including
when that directory happens to be `~/.claude`. The inspection UI lets the owner
choose either or file storage; readers never fall back between them. These are
version-specific readers, covered by synthetic tests, not new live-consent or
renewal claims. Accounts retain their store choice after restart. Every routed
credential read observes the current store, including changes by an ordinary CLI;
AAR's own login exclusion cannot lock unrelated CLI processes.

Pool/grant/account edits require the last observed revision. Stale edits fail
with 409. Account provider/profile identity cannot be edited. Retirement retains
a disabled tombstone and the credential profile; the ID cannot be reused.
Observations are invalidated on account changes, and generation checks discard
late catalog/quota results. Admission rechecks grants after asynchronous reads.
Explicit CLI login excludes renewal for that account; it has a bounded lifetime,
a cancel operation and safe metadata only. Browser consent remains a human step.
The CLI owns token exchange and persistence.

Integration discovery includes `directAccountAccess`; accounts visible solely
through pools cannot be used for direct standalone allocation. Pool allocations
must retain the exact pool grant and membership. Removing a grant, member or
account blocks future requests without account substitution. Already accepted
streams may finish. Owner metadata includes affected committed binding counts.
Usage/catalog refresh remains explicit and per account.

## Migration

Control schema 3 removes integration ownership from pools and converts each
legacy owner relationship into a pool use grant. It preserves router and pool
IDs, ordered members, cursor, binding IDs/token hashes, cancellation records,
revocation and direct-account grants. Names do not merge identities. Unmodified
legacy state initially grants no new account access.

Private `.pre-v3` backups retain the original control/accounts/clients state.
The account and manual-client registries use versioned envelopes so old array
writers fail instead of overwriting live state. New readers accept legacy arrays
until the exclusive upgrade completes. Writes fsync before atomic rename;
control publication follows registry upgrades, so an interrupted migration can
be retried. Downgrade is unsupported. Restore a complete consistent backup only
with all router and administration processes stopped.

`router-owned-pools-v1` explicitly advertises the new authority contract alongside
`pools-v1` for allocation/overview compatibility. Integration pool mutation is
403; owner mutation uses the owner namespace. Integration overviews report
`canManagePools: false`. YA capability 116 hides editing, preserves legacy router
fallbacks, and keeps pool-only accounts out of direct allocation choices.

See [desktop setup](../desktop/README.md), [control](control.md),
[pools](pools.md) and the [implementation plan](router-owned-pools-and-desktop.md).

## Desktop lifecycle (0.1.4)

Closing the management window hides it. Quit stops the router and app, including
accepted streams, managed helper processes and official sign-ins. An attached
router is also shut down through authenticated owner IPC. `stop` remains the
idle-only operation used before updates; owner-only `shutdown` requires the
current router ID and cancels active work. Integration credentials cannot use it.

`desktop-serve` holds a private stdin pipe to the app. EOF (including an app
crash) triggers shutdown. The ordinary headless CLI remains independently usable;
the desktop exposes no keep-running mode. Startup errors use a bounded safe
message envelope, never raw provider output or configuration contents.


## Account removal (0.1.5)

Desktop account actions are Disable/Enable (reversible) and Remove. The legacy
Retire API remains compatible but is no longer offered in the UI. Retired rows
can be removed too. Removal is owner-only, revision-checked and refuses active
routing, metadata work, or the selected account's renewal/sign-in.

Removal atomically drops the account row and reserves its old ID in
`accounts.json`'s `removedIds`. Only the ID is retained, not the profile path or
credentials. Pool membership and direct integration grants are cleaned up and
revisioned; startup completes that cleanup after a crash between registry writes.
Durable session pins and legacy gateway references cannot attach to a new
account. The same preserved folder can be enrolled using a fresh account ID.

`accounts/removal-preview` returns the selected path, current revision, deletion
eligibility/reason and an opaque filesystem identity. `accounts/remove` defaults
to keeping files. Deletion requires explicit `deleteProfile: true`, the matching
`home` and `deleteIdentity`. Only router-managed direct child directories are
eligible; imported/external homes, aliases, shared parent folders and other
filesystems are refused. Recursive deletion does not follow symlinks. The
account is disabled before deletion, and a filesystem failure leaves that row
available for recovery. Deleting a folder does not remove Keychain entries.

The confirmation dialog shows the exact folder, defaults deletion off on every
open, and leaves Cancel focused. Browser tests cover cancellation, failures,
retired rows, imported profiles and both removal choices. Synthetic core tests
cover scope, revision/identity checks, filesystem failure, preserved credentials,
reference cleanup, restart and non-revival of old account access.


## Automatic desktop observation (0.1.7)

Successful pairing or other external registry writes update an already-open
management window without Reload. The native shell observes metadata for
`control.json`, `accounts.json` and `clients.json` at 250 ms intervals, including
atomic file replacements, then emits a payload-free event to the owner window.
This does not read credential files, perform provider requests or add a public
subscription endpoint. The UI coalesces updates and preserves open editors.

The native `observe` operation only reads the running owner's overview; unlike
explicit Reload, it cannot start the core. The native WebView smoke pairs through
the real private control socket after the empty Connections view is rendered,
then checks that the connection appears without a reload and that observation
cannot revive an explicitly stopped core.
