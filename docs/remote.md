# Hosted router: one public HTTPS AAR for several machines

Status (2026-11-15): **the AAR side is implemented** and covered by synthetic
tests (`test/public.test.ts`, `ui/src/connections/ConnectionsTab.test.tsx`).
**Yep Anywhere does not use it yet**: YA still connects only through the local
control socket and refuses non-loopback inference origins; the YA changes are
listed under [Yep Anywhere changes](#yep-anywhere-changes). Without
`--public-origin`, nothing here is active and behavior is unchanged.

## Goal

Run one AAR (for example on a small always-on Linux host) at a public HTTPS
name such as `aar.example.com`, and point every other machine's Yep Anywhere
at it, without a private network or VPN. Remote YA keeps full functionality:
account and pool selection, quotas, per-session pinning, switching and
recovery. New machines join through a device-login style approval.

Non-goals for the first slice: AAR terminating TLS itself, multi-owner or
multi-tenant use, Windows-hosted routers, and moving official CLI OAuth off
the router host. Provider sign-in still runs the official CLI on the router
host.

## Shape

```text
YA machine ──HTTPS──▶ reverse proxy (TLS) ──▶ 127.0.0.1:<public port> (AAR)
                                                   ├─ /claude/*, /codex/*  inference
                                                   ├─ /control/v1/*        integration control
                                                   └─ /*                   dashboard
```

```sh
aar serve --public-origin https://aar.example.com   # public port defaults to 8420
```

`--public-port N`, `AAR_PUBLIC_ORIGIN` and `AAR_PUBLIC_PORT` override. Both
flags are carried through `aar restart`. A minimal Caddy site:

```caddyfile
aar.example.com {
    reverse_proxy 127.0.0.1:8420 {
        flush_interval -1
    }
}
```

- AAR still binds loopback only. The reverse proxy is the deliberate public
  bind and owns the certificate. The origin must be a bare `https://` origin.
- The public listener (`src/public.ts`) dispatches by path prefix to the
  existing handlers. Each surface keeps its own credential class and
  authorization path; no credential is accepted on another surface. The local
  inference listener, dashboard listener and control socket are unchanged.
- Every request must carry exactly the public `Host` (421 otherwise), which
  defeats DNS rebinding to the loopback port.
- Client addresses come from the last `X-Forwarded-For` entry, which the proxy
  appends; they are used only for display and rate limits.
- Proxy-level basic auth, if used at all, must cover only dashboard paths:
  inference and control carry their own bearer credentials in
  `Authorization` (or AAR's gateway-token header).
- Inference requests through the public listener use the same limits,
  authentication and accounting as loopback requests.

## Control over HTTPS

The same protocol-1 operations as the socket ([control](control.md)), under
`/control/v1/`, with `Authorization: Bearer aar_ctl_…`.

- `GET /control/v1/info` reports the public origin as `inferenceOrigin` and adds
  the `remote-pairing-v1` capability. The socket keeps reporting loopback.
- Owner operations (`/v1/owner/*`) answer 404. Owner authority stays with the
  socket and signed-in dashboard sessions.
- Requests carrying `Origin` are refused: control is for servers, not
  browsers.
- Public requests have their own concurrency limit of 16, separate from the
  socket's, and count as busy for idle restarts.

## Device-login pairing

1. YA creates and privately persists its random `aar_ctl_` token and UUID, as
   it does today, and sends `{id, name, tokenHash}` to `POST /control/v1/pair`.
2. AAR records a **pending** request and returns
   `{state: "pending", userCode: "XXXX-XXXX", verificationUri: "<origin>/#pair", expiresAt, interval: 5}`.
   Repeating the same request returns the same code. A different hash for the
   same ID is refused (409). An already approved ID answers `{state: "active"}`.
3. YA shows the code and link. The link opens the dashboard's Connections tab.
4. The owner types the code into **Connections → Pair a device** and chooses
   pool access in the same step, or runs `aar pairing approve CODE --pool NAME`
   on the router host.
5. YA polls `GET /control/v1/pair/status` with its token. While waiting, that
   and every other authenticated operation answer 403
   `{code: "pairing_pending", userCode, expiresAt}`. After approval, status
   answers `{state: "active"}` and normal operations work. An expired or denied
   request answers 401, and YA pairs again for a new code.

Owner-side, `pairings/list` (also the overview's `pairings`) shows each waiting
request's name, address and age, **without its code**, so an unsolicited request
named like a real machine cannot be approved by a click. `pairings/approve`
validates the grants first and then creates the integration with them in one
durable change. `pairings/deny` drops a request. The CLI equivalents are
`aar pairing list|approve|deny`.

Limits: codes use 8 characters from a 32-letter alphabet without `0/O/1/I` and
expire after 10 minutes. At most 16 requests may wait, at most 4 per address,
and each address gets at most 10 pair attempts per 10 minutes. Pending requests
live in memory only, so a router restart drops them. Pairing events (`requested`,
`approved`, `denied`) go to the [event log](events.md). Socket pairing is
unchanged: an identity with no access until the owner grants it.

## Dashboard on the public name

- `aar dashboard url` (run on the router host, e.g. over SSH) prints a
  single-use link for the public origin and the loopback one; the code works
  at either. `aar serve` prints the public link at startup.
- The public site sets a separate `__Host-aar_dashboard` cookie (`Secure`,
  `HttpOnly`, `SameSite=Strict`, `Path=/`). Origin checks and the CSP use the
  `https:`/`wss:` origin. Sessions are shared with the loopback dashboard's
  session list, so `aar dashboard sessions` and `revoke` cover both.
- The public site never accepts the owner credential and never offers
  view-only access, even with `--dashboard-public-readonly`. The signed-out
  page shows `aar dashboard url` rather than local paths.
- A publicly reachable dashboard carries full owner authority. Not
  implemented yet: device-style approval of new browsers by an
  already-signed-in one, and passkeys. Basic auth at the proxy is an optional
  extra layer.

## Yep Anywhere changes

Not implemented; these belong to YA tactical 143:

- A **remote router** connection kind next to the socket kind: base URL plus
  control credential, stored only in YA's server-side private state and never
  sent to browsers.
- The single control request path gains an HTTPS transport to
  `<origin>/control/v1/…` with normal certificate verification and no
  plain-HTTP fallback. The router ID and protocol checks are unchanged; a
  remote connection cannot move to a router with another ID.
- For remote connections, the inference-origin check requires `https:` and the
  configured host instead of loopback, and keeps refusing credentials, paths,
  queries and fragments. Launched CLIs receive the same per-session gateway
  tokens and `…/claude` or `…/codex` base URLs as today.
- Settings gains the URL field, **Pair**, the pending code display, and
  polling of `/control/v1/pair/status`.

## Risks and open questions

- The control and dashboard surfaces are internet-facing. They keep their
  bounded parsing, and pairing is rate limited. Authenticated control
  operations rely on 256-bit bearer tokens and have no per-address limit.
- Gateway and control credentials are long-lived bearer tokens. They are
  revocable per integration and per binding; expiry is not planned.
- Latency to a distant router adds to session start (prepare/commit) but not
  to steady-state streaming beyond the proxy hop.
- YA tactical 143 says "never advertise control operations on the inference
  listener". The public listener is a separate dispatcher whose control and
  inference surfaces keep separate credentials and handlers. The tactical
  should say explicitly whether that satisfies the rule.
