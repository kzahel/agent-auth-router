# Local integration protocol v1

Implemented first slice: Manual account bindings over owner-only macOS/Linux
Unix HTTP at `<state>/control.sock`. Windows control is unavailable. Inference
remains on its separate authenticated loopback listener. Automatic balancing,
pools and remote control are not implemented.

All operations use bounded JSON, `Host: localhost`, no Origin header and a
15-second request deadline. Responses contain metadata only; errors never include
raw upstream bodies. At most 16 control requests run concurrently. Catalogs are
single-flight per account and cached for 60 seconds; quota reads are coalesced
while running. Neither uses background polling.

- `GET /v1/info`: protocol 1, stable router ID, inference origin, capabilities.
- `POST /v1/pair`: owner bootstrap with `{id, name, tokenHash}`. The client
  creates and privately persists its random `aar_ctl_` token and UUID first.
  Only its SHA-256 hash crosses pairing. Repeating the same pair is idempotent;
  conflicting or revoked IDs cannot pair again. The grant snapshots all enabled
  enrolled accounts; later enrollment does not automatically widen it.
- All remaining operations require `Authorization: Bearer <control token>`.
- `GET /v1/accounts`: granted enrollment IDs, provider, enabled state and renewal
  support, never profile paths or provider account identity.
- `POST /v1/catalog`, `POST /v1/quotas`: `{accountId}`. Catalog discovery is
  possible before allocation. Catalog entries are evidence of model availability,
  not guaranteed entitlement. Quotas preserve the existing normalizer's limits.
- `POST /v1/bindings/prepare`: `{id, accountId, provider, model, tokenHash}`.
  YA persists the allocation UUID and random `aar_` inference token before this
  request. The selected model must be in the account catalog. Identical repeats
  retain the same pin; conflicts are refused. Prepared tokens cannot infer and
  admission expires after five minutes.
- `POST /v1/bindings/commit`, `/cancel`, `/inspect`: `{id}` scoped to the
  integration. Commit durably activates the inference hash. Cancel permanently
  revokes this binding. Committed pins survive restart and idle periods; failed
  native startup may retry the committed pin. This is not a cross-process atomic
  native-launch transaction.
- `POST /v1/disconnect`: `{}`. Revokes the integration and every derived
  inference credential for subsequent requests. Accepted streams may finish.
  Lost acknowledgements can be checked by the credential's subsequent 401.

Control state stores hashes in one private, fsynced, atomically renamed JSON
file. State writes finish before acknowledgements or in-memory publication.
The socket owner is the sole writer. A pre-existing socket path is refused;
after an unclean exit an operator must verify and remove the stale socket.
Do not start two routers against one state directory. New accounts require a
router restart before use; disabling/removing an enrolled account immediately
blocks its derived credentials. Local bootstrap trusts the OS account; it does
not isolate mutually malicious processes running as that account.

The YA integration uses an immutable allocation ID independent of provider/YA
session-ID remapping. Downgrading YA with routed app data is unsupported. Native
compatibility and real renewal evidence remain separately recorded observations.
