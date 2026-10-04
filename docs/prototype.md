# Prototype status

Status: first headless slice, updated 2026-10-03. Synthetic fixtures cover the
router and renewal machinery. One authorized real Codex interaction and one
real Claude Code interaction through the router succeeded. Codex forced
auth-only renewal did not succeed; automatic renewal when due remains
unverified for both providers.

## What exists

`src/` requires Node 24 or newer and uses TypeScript with no runtime
dependencies. Node runs the `.ts` sources directly; `npm run build` emits `dist/`.

| Module | Responsibility |
| --- | --- |
| `gateway-auth.ts` | `aar_` tokens (32 random bytes), SHA-256 hashes at rest, Bearer or `x-api-key` presentation, one granted account per provider |
| `credentials.ts` | Read-only file readers and an opt-in, profile-specific Claude macOS Keychain reader; refresh tokens are never returned |
| `process.ts` | Shell-free spawn with an allowlisted environment, hard deadline, process-group termination and bounded stderr |
| `helpers.ts` | `codex-app-server` and generic `command` renewal helpers; refuses profiles whose config overrides the provider endpoint |
| `quotas.ts` | On-demand, metadata-only Codex app-server and Claude OAuth usage reads; normalizes percentages and reset times |
| `coordinator.ts` | Per-account single-flight renewal, reread verification, backoff, observable states, one forced recovery after 401 |
| `providers.ts` | Route allowlists, fixed upstream origins, request-header allowlists and response-header denylist |
| `server.ts` | Loopback HTTP listener: authenticate, select, substitute credential, stream, cancel, bound, log metadata |
| `state.ts`, `cli.ts` | Private state directory and the `aar` command |

Renewal is demand-driven: a request that finds its credential inside the
renewal window (default five minutes) triggers the helper. There are no
background timers, so inactive accounts cause no helper activity, and sleep or
restart is handled by checking stored expiry on the next request.

## Routes

| Client base URL | Method and path | Upstream |
| --- | --- | --- |
| `http://127.0.0.1:8417/claude` | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` | `https://api.anthropic.com`, same path |
| `http://127.0.0.1:8417/codex` | `POST /responses`, `POST /responses/compact`, `GET /models` | `https://chatgpt.com/backend-api/codex/...` |

Everything else is 404/405. Absolute-form request targets, upstream 3xx
responses and WebSocket upgrades are refused. The router adds
`anthropic-beta: oauth-2025-04-20` for Claude and `chatgpt-account-id` for
Codex. The Codex model-catalog and response paths worked in the live smoke
tests below. Claude model listing and Messages streaming also worked.
Compaction and Claude token counting remain source observations from the
references in [sources](sources.md), unverified against the live services.

## Earlier local observations (2026-10-02)

Recorded in the preceding session on 2026-10-02 without signing in or reading
credentials. These are earlier version observations, not the current host's
version inventory.

- Codex CLI 0.155.1. `codex app-server generate-json-schema` documents
  `account/read` with `GetAccountParams.refreshToken`: "When `true`, requests a
  proactive token refresh before returning. In managed auth mode this
  triggers the normal refresh-token flow." The first helper implementation
  sent `initialize`, `initialized`, then `account/read {"refreshToken": true}`,
  then closed stdin. The current helper checks cached account state before
  attempting forced refresh; see the experiment below.
  Whether it persists the renewed credential to `auth.json` is unverified.
  The schema also has `account/rateLimits/read` and `account/usage/read`,
  relevant to the later dashboard. `aar account add` seeds new Codex profiles
  with `cli_auth_credentials_store = "file"`. That key appears in the 0.155.1
  binary, but it has not been confirmed to make `codex login` write
  `auth.json`.
- Claude Code 2.1.285. `claude auth` exposes `login`, `logout` and `status`;
  `claude setup-token` creates a long-lived token. No auth-only refresh
  operation is visible. Claude accounts default to no helper, so an expired
  Claude credential reports `login_required`. The generic `command` helper
  exists to test candidate invocations.
- On macOS Claude Code normally stores credentials in the Keychain. The
  reader at that point only handled `.credentials.json` and reported
  `unsupported` when it was absent on macOS. No Keychain reader existed then;
  the later explicit enrollment mode and live proof are recorded below.

## Authorized Codex experiment

Run on macOS on 2026-10-02 with Node v26.7.0, Codex CLI 0.159.0 and Claude
Code 2.1.280. Claude was version-checked only; no Claude credential was read.
The original prototype targeted Node 24; this check run used Node 26.

- Regenerated the installed Codex app-server JSON schema in a temporary
  directory with a separate, empty `CODEX_HOME`. `GetAccountParams.refreshToken`
  still documents proactive managed-token refresh. The
  [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
  also describes this operation. Schema support does not prove successful
  renewal on this host.
- The user completed `codex login --device-auth` in a dedicated enrolled
  profile configured with `cli_auth_credentials_store = "file"`. Codex wrote
  a readable `auth.json`. Profile permissions were `700`; configuration and
  credential files were `600`. This confirms file storage for this login and
  CLI version, rather than every Codex configuration.
- The original `aar renew` ran one app-server helper. Its forced
  `account/read {"refreshToken": true}` returned a null account. The command
  exited with status 2 and originally reported `login_required`.
- A fresh diagnostic process recognized the account with
  `account/read {"refreshToken": false}`. A second process checked cached
  account state and then requested forced refresh in the same session:
  cached state recognized a ChatGPT login; forced refresh returned a null
  account again. Its stderr matched a refresh-failure diagnostic. The exact
  underlying failure is unresolved; this does not establish revoked or
  expired refresh credentials.
- One further direct diagnostic requested cached state then forced refresh
  while filtering stderr to a fixed vocabulary. Refresh again returned no
  account, and the filter did not recover a useful error description. No
  additional automatic refresh retries were scheduled.
- Access-token expiry before and after both refresh attempts remained
  `2026-10-12T20:16:44.000Z`. The access token did not change. A fresh reader
  process could read the unchanged credential and observed the same expiry.
  This proves persistence of the original login, not renewed credentials.
- Provider-reported `account/usage/read` and `account/rateLimits/read`
  snapshots were available and unchanged across the first renewal attempt.
  No inference was requested. These snapshots do not prove billing behavior
  or exclude delayed usage reporting.
- Diagnostic responses and stderr were captured in memory; only selected
  metadata was emitted. No token values or account email addresses were
  printed or saved as evidence. Helper and diagnostic processes exited.

The helper now reads cached account state first. A missing account before
refresh maps to `login_required`; an account that disappears from the refresh
response maps to a failed, unverified renewal. Forced recovery reports
`unavailable` and backs off, while ordinary demand can keep using an unexpired
credential. Two synthetic regression cases verify this classification and
fallback. The revised helper has not been rerun against the real profile;
the live failure's root cause and durable renewal remain unverified.

### Source trace after the experiment

Inspected the Codex checkout at revision
`44dd77b71e88c78295736bffd3dc3b684c13be6d`; this is source evidence, not a
new live experiment or proof that the installed binary matches that revision.

- [Managed auth scheduling](https://github.com/openai/codex/blob/44dd77b71e88c78295736bffd3dc3b684c13be6d/codex-rs/login/src/auth/manager.rs)
  checks expiry when `AuthManager::auth()` is used. If access-token JWT expiry
  is readable, refresh becomes due within five minutes of expiry. Only when
  expiry cannot be read does it fall back to `last_refresh` older than eight
  days. This path has no daily renewal rule. Model catalog polling can also
  exercise auth reads; polling frequency is not token-rotation frequency.
- [The fixture test `returns_fresh_tokens_as_is`](https://github.com/openai/codex/blob/44dd77b71e88c78295736bffd3dc3b684c13be6d/codex-rs/login/tests/suite/auth_refresh.rs)
  gives auth a nine-day-old `last_refresh` and an access token with one hour
  remaining, and expects no refresh requests. The test was read, not run here.
- Explicit `refresh_token()` bypasses the expiry predicate, acquires a
  refresh lock and reloads the matching account's store. Changed credentials
  are reused; unchanged credentials trigger the OAuth refresh request. On
  success Codex saves returned tokens and `last_refresh`, then reloads its
  in-memory cache. HTTP 401 recovery separately reloads and then refreshes,
  with a bounded number of recovery steps.
- [Account reporting](https://github.com/openai/codex/blob/44dd77b71e88c78295736bffd3dc3b684c13be6d/codex-rs/model-provider/src/provider.rs)
  hides an account when a permanent refresh failure is cached for its current
  auth. That cache is process-local; the credential file need not be deleted.
  [The app-server account handler](https://github.com/openai/codex/blob/44dd77b71e88c78295736bffd3dc3b684c13be6d/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
  does not return the refresh outcome directly. This supplies a possible
  explanation for the observed null account after refresh and recognized
  account in a fresh process. It does not identify the live rejection code;
  freshness alone does not explain the failed forced refresh.

## Authorized proxy smoke test

Run on 2026-10-02 with Node v26.7.0 and Codex CLI 0.159.0. This was a separate
experiment from renewal: the existing access token was outside the renewal
window, and zero renewal helpers ran.

- A temporary router registry pointed to the enrolled profile without copying
  provider credentials. `aar client add` issued a gateway token and client
  configuration. A separate temporary client `CODEX_HOME` contained that
  configuration, with the token supplied through `AAR_TOKEN`; it had no
  `auth.json` before or after the interaction.
- An authenticated `GET /codex/models?client_version=0.159.0` returned HTTP
  200 and eleven models. Missing gateway authentication returned 401.
- `codex exec` used the generated custom provider configuration, model
  `gpt-6-luna`, low reasoning effort, an ephemeral session, a neutral working
  directory, read-only sandbox, disabled shell and web search, and zero
  configured request/stream retries. It requested only `ROUTER_OK`, used no
  tools, returned that reply, reported `turn.completed`, and exited 0.
- The client sent one `POST /codex/responses`; the router relayed upstream
  HTTP 200 in fifteen body chunks. The first body chunk arrived about 1.05 s
  after the request started, before the connection closed at about 1.85 s.
  The router logged `client_closed`: the client had already reported semantic
  completion but closed before the HTTP response finished. The router does
  not parse Responses events, so this outcome alone is not a failed turn.
- Client-reported usage was 8,790 input tokens (2,816 cached), eight output
  tokens and zero reasoning output tokens. A short prompt still includes the
  CLI's instructions. This consumed subscription inference usage; no billing
  amount or delayed quota impact was measured.
- Observed request header names included `authorization`, `content-type`,
  `accept`, `originator`, `user-agent`, `session-id`, `thread-id`,
  `x-client-request-id`, `x-codex-*` and
  `x-openai-internal-codex-responses-lite`. The current allowlist forwarded
  `content-type`, `accept`, `originator`, `user-agent` and `x-codex-*`, while
  substituting provider authorization and account ID. The other listed
  metadata headers were dropped. Success establishes compatibility for this
  one turn; it does not establish which headers are required or optional for
  continuation, caching or other features.
- The generated custom provider does not enable WebSockets, and the live
  interaction used HTTP streaming. An explicit upgrade probe returned 501.
  In a separate synthetic-only experiment, the installed real Codex client
  with `supports_websockets = true` attempted two upgrades, received 501, and
  fell back to HTTP. The fake upstream deliberately returned 400, ending the
  turn without inference. WebSocket forwarding itself is not implemented.
- `aar client revoke` denied the next request with 401 without restarting
  the router. Active HTTP request count returned to zero. The enrolled
  access credential remained readable and unchanged, with expiry
  `2026-10-12T20:16:44.000Z`.
- Provider responses and client output were captured in memory; only selected
  metadata was reported. Temporary client homes and router state were removed,
  and test processes and listeners were stopped. The enrolled login remains
  available. No provider credential or account email was printed.

The live harness added a response-close observer and crossed Node's default
listener-warning threshold. A synthetic rerun reproduced the warning with
that extra observer; replacing it with a finish observer eliminated the
warning. The fixture suite did not emit it either. This identifies an
instrumentation-triggered threshold warning, not evidence of a listener leak.

## Authorized Claude proxy smoke test

On 2026-10-02, checked installed Claude Code 2.1.280. `claude auth login`
supports `--claudeai` for subscription login. The user completed that login
in a dedicated enrolled profile with directory permissions `700` and no
renewal helper, using a clean environment.

The [official authentication documentation](https://code.claude.com/docs/en/authentication)
describes per-directory Keychain isolation with `CLAUDE_CONFIG_DIR`. Inspection
of the installed executable found a service-name derivation using the first
eight hex characters of SHA-256 over the configuration-directory string, and
an account selector from the OS username. An explicit secure-storage directory
override and custom OAuth settings can change this selection, so the supplied
login command starts with a clean environment. This is version-specific source
evidence, confirmed by the successful reads of the enrolled Keychain entry
below. The enrolled profile had no `.credentials.json`.

The router now supports explicit `credentialStore: "claude-keychain"` enrollment
(`aar account add ... --credential-store claude-keychain`). File storage remains
the default. The Keychain reader uses `/usr/bin/security` with fixed argv,
an exact profile-derived service and OS username, a five-second deadline,
64 KiB stdout bound and discarded stderr. It never enumerates Keychain entries
or falls back to the unsuffixed service or another credential file. It returns
only access credentials and metadata; no credential bundle is copied. Custom
OAuth service suffixes and secure-storage-directory overrides are unsupported.
The official CLI continues to own login, persistence and renewal.

- The profile-specific credential was readable with expiry
  `2026-10-03T05:14:42.197Z`; the same entry remained readable from a fresh
  process after the test. The user's normal Claude login was not read.
- A temporary router registry referenced that profile. `aar client add`
  issued a separate gateway token; the client used the printed
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` configuration with an empty
  temporary client `CLAUDE_CONFIG_DIR`. No provider credentials were copied
  into that client directory, and it had no `.credentials.json` afterwards.
- Authenticated `GET /claude/v1/models` returned HTTP 200 and thirteen models.
  Missing gateway authentication returned 401.
- The installed `claude --print` client used `--bare`, `--safe-mode`, empty
  settings sources, strict empty MCP configuration, no tools, no Chrome,
  no session persistence and denied permission prompts. The selected model
  was `claude-haiku-4-5-20251001`, with low effort, a $0.05 CLI budget bound,
  zero configured retries and nonessential traffic disabled.
- The client requested only `ROUTER_OK`, streamed partial messages, reported
  a successful result with that reply and exited 0. It used no tools.
  One `POST /claude/v1/messages` returned upstream HTTP 200 in twenty body
  chunks. The first body chunk arrived about 685 ms after request start;
  the response finished at about 1.19 s.
- The client also made an unauthenticated `HEAD /claude/api/hello` probe.
  The router refused that unlisted path with 404. It did not contact an
  upstream for the probe, and the client continued successfully. No new
  passthrough route was added. Token counting was not requested in this run.
- Observed Messages headers included `authorization`, `anthropic-beta`,
  `anthropic-version`, `anthropic-dangerous-direct-browser-access`, `x-app`,
  `x-claude-code-session-id`, `x-stainless-*`, `content-type`, `accept` and
  `user-agent`. The existing adapter substituted provider authorization,
  forwarded allowlisted metadata, and added `oauth-2025-04-20` to the beta
  list. This establishes one-turn compatibility, not exhaustive header
  requirements or support for every Claude Code feature.
- Client-reported usage was 155 input tokens and 55 output tokens, including
  45 thinking tokens, with no cache usage or server tool calls. The CLI
  reported an estimated cost of $0.00043; that is not evidence of a separate
  subscription charge or measured quota impact. This was real inference.
- Revoking the gateway client denied the next request with 401 without a
  router restart. Active HTTP requests returned to zero. The enrolled access
  credential and expiry were unchanged, and zero renewal helpers ran.
- Temporary state and client directories were removed, and processes and
  listeners were stopped. Only selected metadata was reported. No provider
  token or account email was printed. The dedicated enrollment now selects
  Keychain storage; its official login remains available.

### The Claude hello probe

Inspected CLIProxyAPI at the previously referenced revision
`6fecc6e5567912661654a4eaf9b8f5436facd1c2` and current source revision
`2044a01f422998de79a5da8015141b878886534d`. Neither has an `/api/hello`
route. Its [route registration](https://github.com/router-for-me/CLIProxyAPI/blob/2044a01f422998de79a5da8015141b878886534d/internal/api/server_routes.go)
provides `GET` and `HEAD /healthz`, while its
[unmatched-route handler](https://github.com/router-for-me/CLIProxyAPI/blob/2044a01f422998de79a5da8015141b878886534d/internal/api/server_management.go)
returns 404 for ordinary unknown paths. This was inspected, not runtime-tested;
embedding configurators or global service gates can alter behavior.

The installed Claude Code 2.1.280 executable contains a `preconnectFired`
guard and a best-effort `HEAD` fetch to the configured API base plus
`/api/hello`, with a ten-second deadline. It sends no authorization, does not
await the fetch, ignores network rejection and does not inspect HTTP status.
This is source evidence for connection warmup, consistent with the successful
live turn despite 404. Other code paths use `GET /api/hello` for preflight
diagnostics and expect 200; those paths were not exercised by this smoke test.
The router's endpoint allowlist remains unchanged.

## Authorized quota reads

On 2026-10-03, with Node v26.7.0, Codex CLI 0.159.0 and Claude Code
2.1.280, `aar account quotas <id>` successfully queried each enrolled
provider profile. Observations were taken around 01:42 UTC. Actual usage
snapshots are reported to the operator, without recording account inventory
or current quota values here.

- Codex used a fresh official app-server process with the enrolled
  `CODEX_HOME`, an allowlisted environment and a neutral working directory.
  The protocol was `initialize`, `initialized`, then
  `account/rateLimits/read`. No forced `account/read` refresh or model
  session was requested. The response contained a seven-day primary window;
  no secondary window was reported. Window length comes from
  `windowDurationMins`, not from an assumption that primary means five hours.
- Claude read the enrolled credential store and requested
  `GET https://api.anthropic.com/api/oauth/usage` using the current access
  token. This is an internal endpoint observed in the installed CLI, not a
  documented public API contract. It returned five-hour and seven-day
  windows. Embedded CLI rendering treats usage JSON `utilization` as a
  percentage; inference response-header utilization instead uses a fraction.
- Output contains the local enrollment id, provider, observation timestamp,
  named quota windows, used/remaining percentages and ISO reset timestamps.
  No token values, emails, raw provider responses or helper stderr are
  emitted. Missing windows are omitted; unknown values remain null.
- These were usage-metadata requests only, with no inference or router-owned
  OAuth exchange. They do not establish billing behavior, credential renewal,
  or that every possible model-specific/spend-control limit is represented.

The command queries all enrolled accounts unless given an id, and exits with
status 2 if any selected account is unavailable while preserving successful
snapshots. Requests have deadlines and output bounds. Redirects are refused;
authentication failures and throttling are returned without automatic retry.
Numeric `Retry-After` values are preserved. Poll scheduling, cached snapshots,
model-scoped `limits[]` rows, spend balances and routing decisions remain
future work. Quota reads are local administration, not an inference-listener
route.

## Verified by tests

`npm run check` passed typecheck and 65 `node:test` cases (about 6 s) on the
current host after installing development dependencies from the lockfile.
All automated cases use fixtures:

- Missing, invalid, revoked and wrong-provider tokens are denied before any
  upstream or credential work. Revocation applies on the next request.
- Client `authorization`, `x-api-key`, cookies and unlisted headers never
  reach the upstream. Upstream `set-cookie` and `location` never reach the
  client.
- SSE chunks reach the client before the upstream finishes. Client
  disconnect closes the upstream request and frees the active-request slot.
- Concurrent demand for a due credential runs one helper per account, and
  different accounts renew in parallel.
- A helper that exits successfully without changing the stored credential
  counts as a failure. Failures back off exponentially (30 s to 10 min)
  without reruns during the backoff. A due but unexpired credential stays
  usable while renewal fails.
- An upstream 401 rereads storage, forces at most one renewal and retries
  once. A persistent 401 is relayed and marks the account `login_required`.
- The fake app-server receives `initialize`, `initialized`, cached
  `account/read {refreshToken: false}`, then forced
  `account/read {refreshToken: true}` for a signed-in profile. A logged-out
  profile maps to `login_required` without requesting refresh. A null account
  after refresh fails with backoff instead of claiming the profile is logged
  out; an unexpired credential stays usable. Server-initiated requests are
  declined. A hung helper, and a helper's descendants, are terminated at the
  deadline.
- Helper environments omit `ANTHROPIC_*`, `OPENAI_*`, the caller's
  `CODEX_HOME` and gateway tokens. Profiles whose config overrides the
  provider endpoint do not start a helper.
- Prompts, response bodies, provider access tokens, gateway tokens and
  secrets in helper stderr stay out of logs and status.
- The Keychain reader is tested with a fake command only: exact service/account
  selection, credential replacement, no fallback, missing/inaccessible stores,
  malformed data, unsupported platforms and providers, oversized output,
  timeout termination, and exclusion of refresh tokens and stderr secrets.
- Printed login commands are tested with fake CLIs and literal shell
  metacharacters in profile paths. Claude's command clears inherited auth,
  storage and cloud-provider overrides.
- Quota fixtures cover Codex multi-bucket and legacy responses, exact RPC
  methods, profile/environment isolation, rejected server token requests,
  endpoint override refusal, deadlines, output bounds and malformed protocol.
  Claude fixtures cover selected-profile token replacement, fixed usage path,
  percentage units, unknown/null values, redirect refusal, authentication
  failures, repeated 429s without retries, bounded stalled/oversized/malformed
  responses and missing/disabled profiles. CLI tests cover account selection,
  sanitized unavailable output and exit status. No automated quota test reads
  real credentials or contacts a provider.

## Not done or not verified

- Durable real Codex renewal has not succeeded. The original helper and a
  direct app-server diagnostic both failed to renew an enrolled profile.
- Codex has completed one real HTTP streamed turn. Multi-turn continuation,
  compaction, comprehensive header requirements and live WebSocket fallback
  remain unverified. WebSocket forwarding is refused; fallback was exercised
  with a real client against synthetic upstreams only. Claude Code has also
  completed one real streamed turn using the OAuth beta flag. Multi-turn,
  tool-call forwarding, token counting and comprehensive Claude features
  remain unverified.
- Body bytes, header bytes, request time, active requests, upstream header
  wait and stream idle time are bounded. Slow-reader, TLS-failure,
  repeated-429 inference and shutdown-during-stream cases are untested. The
  quota reader's stalled-response and repeated-429 cases are fixture-tested;
  those do not cover inference streaming containment.
- File credential stores and an explicitly enrolled, profile-specific Claude
  macOS Keychain entry are supported. Claude renewal is not implemented or
  verified; an expired Claude credential requires official CLI login unless
  a verified helper is enrolled. There is no dashboard, no HTTP administration
  and no automatic multi-account routing. Multiple enrolled accounts can be
  assigned to different gateway clients, each with fixed provider assignments.
- The agreed YA tactical 143 plans local socket pairing/control, scoped grants,
  account pools/policies and durable per-session bindings across both
  repositories. None of these features is implemented; see
  [the integration direction](plan.md#yep-anywhere-integration).
- Renewal after a router restart in the middle of a helper run is not
  coordinated with an orphaned helper.

## Next investigation

Resolve why forced app-server refresh fails while cached account reads and
usage queries succeed. Inspect diagnostics without exposing credentials or
account identity; avoid blind repeated renewal attempts or assuming that a
new login is required. The helper-classification fix is covered by fixtures,
but does not itself fix provider renewal.

The explicit experiment commands remain:

```sh
npm run aar -- account add codex-exp --provider codex
# for a new profile only; do not re-add the already enrolled account
# run the printed `codex login` command, optionally adding --device-auth
npm run aar -- account list            # expiry metadata only
npm run aar -- renew codex-exp         # forces one app-server account/read refresh
npm run aar -- account list            # expect a later expiry, readable after exit
```

These commands are opt-in and never part of `npm run check`. `renew` prints
verified renewal expiry and whether recovery obtained a different credential;
on failure it can print an unknown after-expiry even when the original store
is still readable. Reread the enrolled profile in a fresh process to check
actual stored expiry and persistence. Record usage impact separately.

The independent proxy smoke tests above succeeded using the current access
credentials. Further synthetic tests can cover slow readers, TLS failure,
repeated 429s, shutdown during streaming and helper ownership across restart
without consuming subscription usage. Real automatic renewal when due and
multi-turn client behavior remain separate experiments.
