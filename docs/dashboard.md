# Live dashboard, traffic history and headless web UI

Status: implemented 2026-10-06, synthetic fixtures only. It refines
[plan phase 5](plan.md#5--add-the-local-dashboard-and-account-onboarding) and
the dashboard notes in [architecture](architecture.md#dashboard-and-desktop).
The provider usage fields below follow the documented stream formats and are
exercised with synthetic streams; they have not yet been checked against
captured traffic from the supported Claude Code and Codex versions.

## Goals

- A **Dashboard** tab showing live activity per account, per pool and in
  total: active streams, token rates, cache use, requests and errors.
- A traffic history graph in the style of a BitTorrent client's speed tab,
  modelled on rstorrent's `SpeedPanel`: ranges from 2 minutes to 30 days,
  smooth scrolling and a recent-requests list.
- A headless mode in which the core serves the same management UI to a
  browser on loopback, with no Tauri app. The desktop app and the web
  dashboard are parallel, supported surfaces with one UI codebase. The web
  mode is also the faster iteration loop and gives Linux a UI before native
  builds exist.

Non-goals: LAN or remote dashboard access, cost estimates, exact local
tokenization, and any change to credential ownership.

## Usage capture

`src/usage.ts` taps the relayed response in `src/server.ts`. The tap listens
for `data` events on the upstream response right after `pipeline()` attaches,
so it sees every chunk the client receives without delaying, buffering or
resuming a stream that backpressure paused. A tap error disables the tap for
that request and is logged; the relay continues.

- SSE framing is parsed incrementally across arbitrary chunk and UTF-8
  boundaries, with LF or CRLF line endings. Only `data:` fields accumulate;
  other fields and comments are skipped as they stream.
- An event is parsed whole up to 1 Mi characters. A larger event keeps its
  first 512 characters (for its `type`) and its last 64 Ki characters, from
  which the final `"usage"` object is recovered. Codex's final event carries
  the whole response object with usage at the end.
- Non-streaming JSON responses use the same bound.
- Only numbers and the model name leave the tap. Content is discarded as it
  is parsed, and nothing about it is logged.
- Inference routes only: Claude `/v1/messages`, Codex `/responses` and
  `/responses/compact`. Claude `count_tokens` and model lists count as
  requests without tokens; no inference happens there.

| Provider | Event | Fields |
| --- | --- | --- |
| Claude | `message_start` | model, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (its `output_tokens` is a placeholder) |
| Claude | `content_block_delta` | text, thinking and tool-input lengths, for the estimate |
| Claude | `message_delta` | final cumulative `output_tokens` (and any updated input fields) |
| Codex | `response.created` | model |
| Codex | `*.delta` | delta lengths, for the estimate |
| Codex | `response.completed`, `.failed`, `.incomplete` | `input_tokens` less `input_tokens_details.cached_tokens` as uncached input, cached tokens as cache read, `output_tokens`, `output_tokens_details.reasoning_tokens` |

Output is reported once, at the end of a response. So that the live graph
moves while a response streams, output follows a coarse estimate of four
characters per token. When the provider's figure arrives, the difference is
recorded at that moment, which can be negative. Completed totals therefore
equal provider figures exactly. A response that never reports usage keeps
its estimate, is flagged `estimated` in the request list (shown as `~`), and
counts in the `unreported` series. Input fields are recorded when they are
reported.

A better estimator can replace the heuristic. Before adding one, check what
CLIProxyAPI uses and weigh it against the narrow-dependency rule.

## Metrics and history

`src/metrics.ts` keeps counters for three kinds of scope: `all`,
`account:<id>`, and `pool:<id>` for requests made through a pool session
binding. Pool attribution is fixed when the request starts, so later
membership changes do not move history. Counters: `requests`, `errors`
(status 400 and above), `input`, `cacheRead`, `cacheWrite`, `output`,
`reasoning`, `bytesUp`, `bytesDown` and `unreported`. Active streams are a
live gauge.

Quota windows observed from proxied responses' rate-limit headers or from
usage refreshes are recorded per account as `quota:<bucket>` gauges (used
percent, last sample per bucket). The latest windows also ride along in live
snapshots, so dashboard quota updates between overview refreshes. Quota
observations do not trigger `change` events, so busy traffic does not
re-render the management tabs.

History follows rstorrent's `crates/rstorrent-session/src/speed.rs`. Each
tier is a fixed ring keyed by `floor(time / bucketMs) % count`, and every
event adds into all tiers at once. Buckets hold sums, and rates are
`sum × 1000 / bucketMs`. A bucket carries a covered flag, so time the router
was not running is a gap, not zero. Only complete buckets are reported.

| Range | Bucket | Count | Persisted |
| --- | --- | --- | --- |
| 2 minutes | 1 s | 120 | no |
| 10 minutes | 5 s | 120 | no |
| 1 hour | 30 s | 120 | no |
| 24 hours | 5 min | 288 | yes |
| 30 days | 1 h | 720 | yes |

The 24-hour and 30-day tiers are saved to `metrics.json` (private, atomic) at
most once a minute and on shutdown. Only covered, non-zero buckets are
written. A corrupt or insecure file is logged and ignored. The last 200
requests are kept in memory with metadata only: times, client name, account,
pool, provider, route, model, status, outcome, bytes and token figures.

## App protocol

Both shells run one UI against one message protocol (`src/app.ts`). Only the
pipe underneath differs.

```jsonc
// client → core
{ "hello": { "token": "…" } }                        // desktop pipe only, first line
{ "id": 7, "call": "pools/save", "body": { … } }
{ "id": 8, "subscribe": "history", "body": { "range": "10m", "scope": "all", "metrics": ["output"] } }
{ "id": 9, "unsubscribe": 8 }
// core → client
{ "hello": { "protocol": 1, "routerId": "…", "kind": "desktop", "revision": 3 } }
{ "id": 7, "result": { … } }                          // or { "id": 7, "error": { "status": 409, "message": "…" } }
{ "id": 8, "result": { /* snapshot */ } }
{ "sub": 8, "event": "history", "data": { /* buckets completed since */ } }
{ "event": "change", "data": { "revision": 4 } }
```

- **Calls** go to the existing owner operation handlers. The core's policy
  allows the management operations the desktop used, plus
  `accounts/login-command`, `metrics/snapshot`, `metrics/history` and
  `requests/recent`. Only the desktop pipe may also call `shutdown`, which
  Quit uses. Dashboard session administration is CLI-only. The Rust
  allowlist is gone.
- **Subscriptions:** `live` pushes a snapshot every second: active streams,
  five-second rates, one-minute totals per scope, the latest quota windows
  and active requests. `history` sends a snapshot and then appends each newly
  completed bucket, with an epoch and `completeThrough` for continuity
  checks. `requests` sends the recent list and then each request as it starts
  and ends. A session may hold 16 subscriptions and 16 calls in flight.
- **Change events** are coalesced to at most four a second. They are emitted
  for registry writes (accounts, clients, `control.json`) and for owner-side
  invalidations such as sign-in progress. All registry writes, including
  offline CLI administration and YA pairing, go through the socket owner. The
  Rust shell's 250 ms registry-file watcher was removed.
- **Reconnect:** the client resubscribes and receives fresh snapshots. The
  core keeps no event backlog.
- On macOS, UI enrollment of a new Claude profile defaults to its Keychain
  entry, matching the official CLI. This rule moved from Rust into the core.
  The headless CLI keeps its file default.

The UI depends on a port (`desktop/ui/app-client.js`). A shared `AppClient`
handles request IDs, subscriptions, change listeners and reconnection with
backoff. Automatic reconnection never starts a stopped core.

## Pipes

- **Desktop:** the core listens on `app.sock` next to `control.sock`
  (owner-only permissions, at most 16 connections, a 5-second hello deadline,
  1 Mi-character lines). The Rust shell (`desktop/src-tauri/src/app_pipe.rs`)
  reads the owner credential, completes the hello and then relays lines,
  using only the standard library's `UnixStream` and `serde_json`. The
  webview never receives the credential.
  - `app_connect(start)` opens the connection and resolves with the hello.
    `start` also starts a stopped core, as Reload and first launch do.
  - `app_send(message)` writes a line; it refuses `hello` messages.
  - `app-message` and `app-closed` events carry the core's lines and the
    connection's end.
  - Terminal launch, updates and launch at login remain separate Tauri
    commands.
  - Lifecycle work in Rust (start, Quit, update, terminal checks) uses
    short-lived calls on the same socket instead of spawning
    `aar owner-request`. A router started by an earlier release has no
    `app.sock`. Lifecycle calls then fall back to the bundled CLI, and the UI
    asks the user to stop that router.
- **Browser:** a WebSocket at `/v1/app/ws` on the dashboard listener carries
  the same messages, one per text frame. `src/websocket.ts` is a minimal
  RFC 6455 server: masked text frames only, messages bounded like the desktop
  pipe's lines, a 16 MiB outbound buffer bound, and a ping every 30 s with a
  75-second idle close.
- **Plain HTTP:** `POST /v1/app/<operation>` on the dashboard listener runs
  the same dispatch, for scripts and `curl`. It needs either the session
  cookie with an exact `Origin`, or `Authorization: Bearer` with the owner
  credential.
- **Windows:** Unix sockets are not used on Windows yet. The desktop pipe
  there would use a named pipe with the same line protocol, tracked with
  Windows parity.

`control.sock` keeps its HTTP API for YA and the `aar` CLI, as tactical 143
specifies. Nothing in this document is served on the inference listener.

## Headless web dashboard

- **Listener:** `aar serve` opens it on `127.0.0.1:8418` by default. If the
  inference listener is configured with port 0, as tests do, the dashboard
  also takes an ephemeral port. Override with `--dashboard-port` or
  `AAR_DASHBOARD_PORT`, or disable with `--no-dashboard`. A taken port fails
  startup with a message naming those options. The desktop app's
  `desktop-serve` and brief offline administration never open it.
- **UI files:** the same files as the desktop. In a checkout they come from
  `desktop/ui`; the desktop bundle copies the allowlisted assets to
  `resources/ui`, so the bundled CLI can serve them too. Terminal-window
  assets and vendored xterm are not served.
- **Sign-in:** `aar serve` prints `http://127.0.0.1:<port>/#code=<code>`, and
  `aar dashboard url` prints a fresh link.
  - Codes are single-use, valid for an hour, and at most 16 are outstanding.
  - The code travels in the fragment, so it is not in request lines, logs or
    `Referer`. The page removes it from history before exchanging it.
  - The exchange sets an `HttpOnly`, `SameSite=Strict` cookie named
    `aar_dashboard_<port>`, with a 400-day lifetime (the browser maximum).
  - Session token hashes are kept in `dashboard-sessions.json` (private, at
    most 64 sessions), so sign-ins survive router restarts.
  - **Log out** revokes the session on the server. `aar dashboard sessions`
    and `aar dashboard revoke <id>|--all` manage sessions from the CLI.
  - Cookies are not isolated by port, so other local services on
    `127.0.0.1` receive this cookie. Those services run as local users;
    loopback-only binding stays the boundary.
- **Request checks:**
  - Exact `Host` (`127.0.0.1:<port>` or `localhost:<port>`) on every request,
    which defeats DNS rebinding.
  - Exact same-origin `Origin` on the code exchange, logout, every cookie
    call and the WebSocket upgrade. Browsers apply no CORS to WebSockets.
  - JSON request bodies only, and no CORS headers.
  - A strict CSP with `'self'` scripts and `connect-src` limited to the
    page's own WebSocket origin. `nosniff`, `no-referrer`, frame denial and
    `no-store` on every response.
- **Desktop-only features in web mode:**
  - **Sign in** shows the official login command with a copy button, then
    **Check sign-in**.
  - Terminal choice, updates and launch at login are hidden.
  - Stopping the router from the web UI follows the desktop's idle rules;
    restarting it needs the command line.
- **Lifecycle:** closing the browser does not affect the router.
- **Development:** UI files are read on each request with `no-store`, so a
  browser refresh shows edits.
  - `aar serve --dev` also watches the UI folder and sends signed-in
    browsers a `ui-reload` event when a served file changes; desktop
    sessions never receive it.
  - `npm run dev` runs `aar serve --dev`. The router is never restarted
    automatically; core edits need a manual restart, after which the
    browser's session cookie keeps it signed in.

LAN, Tailscale and remote access are out of scope. They need their own design
(rstorrent's basic-auth and tailscale-serve modes are a reference) and are
not enabled by this work. Username/password login is a possible addition
for that case.

## Dashboard tab

`desktop/ui/dashboard.js` and `graph.js`. The Dashboard is the first tab; with
no accounts it links to Accounts.

- **Controls:** scope (All traffic, each pool, each account), range (2 min to
  30 days) and units (tokens or bytes), remembered per browser.
- **Summary tiles:** active streams, sent and generated tokens per second,
  one-minute cache hit ratio, requests and errors.
- **Traffic graph:** two panes on a shared time axis, each with its own
  labelled scale. "Sent to model" stacks cache read, cache write and uncached
  input upward. "Generated" draws output downward. Cache reads can exceed
  output by two orders of magnitude, so a shared axis would flatten output.
  The two panes are separate scales, not a dual-axis chart. Bytes mode shows
  uploaded and downloaded the same way.
- **Value table:** last, average, peak and total for each series over the
  visible range. It doubles as the accessible table view, and as relief for
  two light-mode colours below 3:1 contrast.
- **Quota graph** (account scope): used percent per window, holding the last
  sample until the next one.
- **Accounts table:** live sent/generated rates, streams, latest quota, time
  since the last request and a two-minute sparkline. Selecting a row scopes
  the graph to that account.
- **Recent requests:** time, client → account, model, sent tokens with the
  cache share, output (`~` while estimated), duration and status. Active
  requests read "streaming".

Rendering follows rstorrent's `SpeedPanel.tsx` and `speed-geometry.ts`:

- Canvas 2D with no chart library, device-pixel-ratio scaling capped at 3,
  and `ResizeObserver` resizing.
- Monotone cubic curves (Fritsch–Carlson) split at gaps.
- A scroll phase from 0 to 1 over one bucket, reset when a bucket completes.
  It runs only for live ranges while the page is visible and reduced motion
  is off.
- A 1/2/5×10ⁿ scale that rises at once and decays down with a 2-second
  half-life.
- A pointer or keyboard cursor (arrows, Home, End, Escape) with an
  exact-bucket tooltip, and an "updates paused" label after 3 s without data.
- Series use the reference categorical palette in fixed order. It was
  validated for adjacency against this app's light and dark surfaces.

The tab subscribes only while it is visible.

## Verification

Core tests:

- **`test/usage.test.ts`:** both providers, every two-way split and
  byte-at-a-time delivery, UTF-8 inside chunks, CRLF, interruption,
  oversized events, non-streaming JSON, malformed and unknown events, and
  invalid numbers.
- **`test/metrics.test.ts`:** tier sums and appends, gaps, active and error
  counts, estimates, persistence across a restart with downtime left
  uncovered, and corrupt files.
- **`test/app.test.ts`:**
  - Desktop pipe: hello required, core-side policy, subscriptions, live
    traffic events, change events and Mac Keychain enrollment.
  - The inference listener serves none of this.
  - Dashboard: Host and Origin enforcement, single-use codes, hashed
    sessions, WebSocket upgrade checks, web policy, plain HTTP calls, logout
    and port conflicts.
  - A 32 MiB stream to a client that stops reading stalls the upstream, and
    the relayed bytes hash identically.

Desktop tests:

- **`desktop/test/management.test.mjs`:** the management UI over an emulated
  Tauri pipe.
- **`desktop/test/web-dashboard.test.mjs`:** a browser end to end against
  `aar serve` with a mock upstream: sign-in, live streaming rows, exact
  totals after provider correction, quota history, the web sign-in command,
  single-use links and logout.
- **Native smokes:** sign-in, lifecycle, pairing and update all pass against
  the rebuilt app. Pairing confirms change events reach the native UI
  through the pipe, and that reconnection cannot restart a stopped router.

## Open questions

- Confirm the usage fields against captured traffic from the supported CLI
  versions, including `/responses/compact` and error streams.
- Choose a better output estimator, if the four-characters heuristic proves
  too rough (see CLIProxyAPI).
- Add a Windows named-pipe desktop transport.
- Design LAN or remote dashboard access separately.
