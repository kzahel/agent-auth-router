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
metadata only. Owner POST operations include `overview`, `providers`,
`accounts/add`, `accounts/set-enabled`, `accounts/retire`, `accounts/login`,
`accounts/login-status`, `accounts/open-login`, `accounts/cancel-login`,
`accounts/refresh`, `accounts/renew`, `pools/save`, `pools/remove`,
`grants/save`, `integrations/revoke`, `clients/add`, `clients/revoke`, and `stop`.
All use bounded JSON bodies and the same running mutation authority.

`aar owner <operation>` reads JSON from stdin. It contacts the running router,
or temporarily starts the core when offline. Interactive `accounts/login`
requires `aar serve` or the desktop app to keep its CLI process alive.
Socket binding serializes writers;
occupied/stale endpoints are refused. `account add`, client mutation and renewal
also use this authority. There is no owner API on the inference HTTP listener.
Account addition supports a stable ID, provider and optional dedicated home,
credential-store choice and supported official helper. The desktop creates its
profile under the private state directory. No arbitrary helper argv is accepted
through enrollment. New coordinators join the live map without rebuilding peers.

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
