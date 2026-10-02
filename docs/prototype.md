# Prototype status

Status: first headless slice, 2026-10-02. Exercised only with synthetic
credential stores, fake helpers and local mock upstreams. No real credential
was read and no provider endpoint was contacted.

## What exists

`src/` is a Node 24 / TypeScript service with no runtime dependencies. Node
runs the `.ts` sources directly; `npm run build` emits `dist/`.

| Module | Responsibility |
| --- | --- |
| `gateway-auth.ts` | `aar_` tokens (32 random bytes), SHA-256 hashes at rest, Bearer or `x-api-key` presentation, one granted account per provider |
| `credentials.ts` | Read-only file readers for Codex `auth.json` and Claude `.credentials.json`; refresh tokens are never returned |
| `process.ts` | Shell-free spawn with an allowlisted environment, hard deadline, process-group termination and bounded stderr |
| `helpers.ts` | `codex-app-server` and generic `command` renewal helpers; refuses profiles whose config overrides the provider endpoint |
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
Codex. These paths and headers are source observations from the references
in [sources](sources.md), not verified against the live services.

## Local observations

Recorded on this host on 2026-10-02 without signing in or reading credentials.

- Codex CLI 0.155.1. `codex app-server generate-json-schema` documents
  `account/read` with `GetAccountParams.refreshToken`: "When `true`, requests a
  proactive token refresh before returning. In managed auth mode this
  triggers the normal refresh-token flow." This is the auth-only helper
  candidate the `codex-app-server` helper implements: `initialize`,
  `initialized`, then `account/read {"refreshToken": true}`, then stdin close.
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
  Claude reader only handles `.credentials.json` and reports `unsupported`
  when it is absent on macOS. No Keychain reader exists.

## Verified by tests

`npm run check` runs typecheck and 44 `node:test` cases (about 3 s), all
against fixtures:

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
- The fake app-server receives exactly `initialize`, `initialized` and
  `account/read {refreshToken: true}`. A logged-out profile maps to
  `login_required`. Server-initiated requests are declined. A hung helper,
  and a helper's descendants, are terminated at the deadline.
- Helper environments omit `ANTHROPIC_*`, `OPENAI_*`, the caller's
  `CODEX_HOME` and gateway tokens. Profiles whose config overrides the
  provider endpoint do not start a helper.
- Prompts, response bodies, provider access tokens, gateway tokens and
  secrets in helper stderr stay out of logs and status.

## Not done or not verified

- The real `codex app-server` helper has not been run against an enrolled
  profile.
- Claude Code and Codex have not been run against the router. Wire
  compatibility, required headers and the Claude OAuth beta flag are
  unverified, and Codex WebSocket transport is refused rather than assessed.
- Body bytes, header bytes, request time, active requests, upstream header
  wait and stream idle time are bounded. Slow-reader, TLS-failure,
  repeated-429 and shutdown-during-stream cases are untested.
- Only file credential stores are supported, with no Keychain access. There
  is no dashboard, no HTTP administration and no multi-account routing.
- Renewal after a router restart in the middle of a helper run is not
  coordinated with an orphaned helper.

## Next experiment, needing authorization

This needs a real ChatGPT subscription login in a dedicated profile, so it is
deliberately not run by default:

```sh
npm run aar -- account add codex-exp --provider codex
# run the printed `codex login` command in a terminal
npm run aar -- account list            # expiry metadata only
npm run aar -- renew codex-exp         # forces one app-server account/read refresh
npm run aar -- account list            # expect a later expiry, readable after exit
```

`renew` prints expiry before and after and whether the credential changed,
never token values. Running `account list` again in a fresh process covers the
persistence-after-restart check. The `account/read` refresh is expected to be
auth-only with no inference, but that is not proven yet. Watch for any usage
change. If this works, the next step is pointing a dedicated Codex client
configuration at the router (printed by `aar client add`) for one streamed
interaction.
