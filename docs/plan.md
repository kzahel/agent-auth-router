# Implementation and validation plan

Status: research and implementation plan, updated 2026-10-03.
Synthetic-fixture parts of phases 1–4 are prototyped; see
[prototype status](prototype.md). Each provider has completed one real streamed
client interaction and an on-demand quota read; full phase acceptance and
durable renewal remain unverified. Control/pairing and account allocation are
now planned with YA; they are not implemented. The research phases resolve
credential and protocol uncertainty before UI or release packaging.

## Yep Anywhere integration

The canonical cross-repository plan is Yep Anywhere tactical 143,
`docs/tactical/143-agent-auth-router-integration.md`, in the
[Yep Anywhere repository](https://github.com/kzahel/yepanywhere). It covers:

- Local HTTP over an owner-only Unix control socket, explicit pairing, scoped
  integration credentials and separately authorized inference credentials.
- Integration-owned provider pools, Manual/Auto/Earliest reset/Most remaining/
  Round robin policies, model-aware quota freshness and atomic admission.
- Durable per-session pins and gateway credentials, idempotent allocation and
  crash/revocation recovery, with no silent account switching or direct fallback.
- YA server launch adapters, settings and session controls, subscription-usage
  normalization, existing source authorization and compatibility gates.

Follow its contract → local pairing → quotas/pools → allocator/bindings → native
YA launch → UI → authorized live-proof sequence. A standalone router dashboard
is not a prerequisite for YA integration. The phases below retain provider
renewal, protocol and failure-containment research; incomplete renewal remains
a visible limitation rather than justification for router-owned OAuth. Remote
control, Windows parity, automatic failover and cross-account continuation are
separate later proofs. YA's direct CLI profiles remain independent.

## 1 — Prove official CLI credential renewal

Record installed Claude Code and Codex versions and storage modes. Establish
one dedicated profile per provider. Inspect auth-only CLI/app-server operations
and identify the smallest operation that performs and durably persists renewal.

Start with synthetic credential readers and fake helpers. Use real credentials
only in a deliberately authorized private experiment; never include tokens,
account email addresses or Keychain contents in evidence artifacts.

Acceptance:

- Renewal becomes due, the selected helper finishes, and the new access
  credential is durably readable after process exit and router restart.
- Gateway overrides cannot accidentally route the helper through itself.
- Concurrent refresh demand starts one helper per account; different accounts
  remain independent.
- Failure, timeout, cancellation, unchanged credentials, early revocation and
  required interactive login have observable, bounded outcomes.
- Any inference, tool invocation, filesystem side effect or usage cost of the
  chosen helper is understood and documented.

## 2 — Prove a single-account native protocol path

Build the smallest headless Node/TypeScript slice using fixture credentials
and local mock upstreams, then validate authorized real-client compatibility.
Keep one explicitly selected account per provider and an explicit endpoint
allowlist. Document required provider paths, headers and payload adaptations.

Acceptance:

- Claude Messages and Codex Responses clients can complete their required
  startup/model/counting requests and an ordinary streamed interaction.
- Tool-call data survives forwarding without being executed by the router.
- Streaming starts promptly, preserves ordering and honors backpressure.
- Disconnect/cancellation tears down upstream work and releases resources.
- The correct provider credential replaces all incoming authentication material;
  it cannot reach a different host through redirects or a caller-supplied URL.
- Expired/revoked credentials produce truthful errors and no silent replay.
- Both HTTP and any required WebSocket behavior are explicitly assessed. Do
  not claim CLI compatibility by testing only a hand-written HTTP request.

## 3 — Add client identity and account policy

Issue named, revocable gateway tokens, storing hashes. Enforce provider/account
permissions server-side. Keep administration separate from inference. Start
with explicit account selection; conversation affinity comes after identity
and authorization are proven.

Acceptance:

- Missing, invalid or revoked tokens are denied before upstream work.
- A token cannot select an unauthorized account or provider.
- Shared tokens are explicitly shared identities, not inferred process IDs.
- Established conversation bindings cannot bypass later revocation or policy
  changes.
- Refresh rotation does not change gateway tokens or authorized bindings.

## 4 — Establish limits and failure containment

Add request/header/queue/concurrency limits, lifecycle bounds, sanitized
metadata logging and graceful shutdown. Exercise secrets in every synthetic
failure path to demonstrate that credentials and prompts do not leak to logs.

Acceptance includes malformed/oversized bodies, slow readers/writers, upstream
TLS failure, redirects, helper hangs, corrupt storage, repeated 401/429,
shutdown during streaming and restart after renewal. Verify that abandoned
clients and inactive profiles do not leave unbounded background work.

Use deterministic tests for these boundaries. Do not claim production safety
from a happy-path request or absence of known upstream advisories.

## 5 — Add the local dashboard and account onboarding

Local control/pairing for YA follows tactical 143 above and can precede the
router's independent browser dashboard. CLI enrollment already prints the
official login command; terminal launch and graphical onboarding are future work.

Serve embedded assets. Show account readiness, renewal state, client policy,
active requests, cooldowns and actual provider-reported usage. Implement
authenticated browser administration with Host/Origin and CSRF enforcement.
Offer a terminal login command; add a platform terminal launcher only where
supported. [Live dashboard and headless web UI](dashboard.md) details the
usage capture, traffic history, Dashboard tab and browser administration.

Acceptance:

- Provider credentials never reach dashboard JavaScript or browser responses.
- An unrelated website cannot invoke administrative actions through localhost.
- Typing remains responsive during concurrent account/request updates; test
  sequential keystrokes rather than whole-field replacement.
- Dashboard closure does not stop active inference or the headless service.

## 6 — Add constrained multi-account routing

With the identity/protocol/failure boundaries tested, add conversation affinity,
explicit account sets and observed cooldowns. Define a safe pre-generation rejection policy
before enabling any failover. Preserve failures after ambiguous acceptance or
streamed output rather than replaying automatically.

Prefer actual provider signals over locally guessed quota/reset data. Private
multi-device access needs explicit bind/transport configuration and the same
client authorization checks. It does not enable remote administration.

## 7 — Package the optional desktop application

Adopt Desktop Release Kit's Tauri sidecar/update pattern, following Machine
Control's separation of headless runtime and operator shell. The product owns
its tray behavior, lifecycle, account UI, app identity and updater key.

Bundle a pinned Node runtime, compiled service and dashboard in one versioned
package. Verify signing of nested executables, Apple notarization and an actual
installed old-to-new signed update before making distribution claims. Initially
target macOS; assess other host platforms independently.

## Outstanding decisions

- Which exact helper operation renews each provider without inference?
- Which additional Claude versions/platforms support the tested profile-specific
  reader, and what access prompts/failure behavior do they produce?
- Which installed CLI versions and wire paths form the initial support floor?
- How should the proposed per-session gateway allocation persist/recover pins
  and credentials across clients, router restarts and YA worker handoff?
- How should CLI helper processes coordinate with user-requested login and
  service restart?
- What exact versioned operations and recovery semantics implement the agreed
  local control/pairing surface before a standalone dashboard?

Resolve these through bounded experiments, recording versioned observations
separately from intended product behavior.
