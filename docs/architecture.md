# Architecture and security boundaries

Status: mixed implemented prototype and intended architecture, updated
2026-10-06. [Prototype status](prototype.md) identifies the code, fixture
coverage and limited live proofs. The [dashboard](dashboard.md) and its local
web listener are implemented with synthetic tests; remote administration
remains a proposal.

## Product boundary

The router provides narrowly supported model API paths for Claude and Codex.
Claude requests stay in the Claude protocol; Codex requests stay in the
Responses protocol. Subscription endpoints may require specific paths,
headers or payload adjustments; prove and document those adaptations for the
tested CLI versions. A simple header swap is the conceptual authentication
boundary, not a promise of complete wire compatibility.

The current slice has one explicitly selected account per provider per gateway
credential, rather than a limit of one enrolled account overall. Later,
gateway client policy can select from an allowed account set, with stable
conversation affinity and cooldown handling. An HTTP request does not reveal
a client's local PID or home directory. Client identity comes from its gateway
credential; conversation identity needs an explicit, validated identifier.

The agreed YA integration direction uses a router allocation and per-session
gateway credential pinned to an account. This can enforce affinity without
depending on a native session header. Allocation, persistence and recovery are
not implemented; see [the cross-repository plan](plan.md#yep-anywhere-integration).

No protocol translation between providers is planned. Token counting should
use supported provider endpoints and usage should preserve provider-returned
figures. Missing usage is unknown in recorded totals. A dashboard may show a
labeled coarse estimate for in-flight output, replaced by the provider figure
when the response completes.
Whether either CLI requires additional counting, model-list or other routes
is a compatibility question for the first experiment.

## Runtime

- Node.js and TypeScript, compiled to JavaScript for production.
- Standard HTTP/HTTPS primitives, streaming, cancellation and child-process
  APIs where sufficient; narrow runtime dependencies with explicit purpose.
- Provider adapters own upstream paths, permitted headers, small required
  transformations and credential readers.
- A credential coordinator serializes helper activity per account and rereads
  storage after it completes. It does not implement OAuth token exchange.
- An account registry holds opaque account IDs, provider, profile location,
  enabled state and observed authentication health.
- A gateway client registry holds named identities, token hashes, revocation
  state and explicit provider/account permissions.
- A separate local control surface owns account setup, client enrollment and
  status. Inference credentials do not grant administrative authority.

Today that control surface is the router owner's private Unix control socket,
used by the `aar` CLI and YA, plus the UI protocol on `app.sock` and the
loopback web dashboard. None of it is served on the inference listener, and
nothing polls providers in the background.

## Credential ownership

There are three different concepts:

| Concept | Purpose | Owner |
| --- | --- | --- |
| Gateway client token | Proves a client identity and its router permissions | Router |
| Provider access token | Authenticates inference to the selected subscription | Official CLI owns storage; router reads it |
| Provider refresh token | Obtains replacement provider credentials | Official CLI only |

Treat the official CLI's authoritative store as the source of truth. Avoid
long-lived token snapshots. OS credential stores and file formats differ by
provider, platform and version. Read only the explicitly enrolled profile;
never scan the user's general Keychain or unrelated home directories.

An account profile is dedicated to this service's managed helper invocations.
The same credential must not be independently rotated by another gateway,
machine or ordinary user session. A process-local mutex cannot coordinate an
unmanaged external CLI writer; dedicated profiles are part of this boundary.

## Inference handling

1. Validate the gateway token and its permissions before upstream work.
2. Select the explicit account, or use an authorized conversation binding.
3. Obtain its current access credential, invoking the helper when necessary.
4. Remove client authentication headers and attach only the selected upstream
   credential and provider-specific required headers.
5. Forward to an allowlisted provider destination with normal TLS validation.
6. Stream the response with backpressure and propagate client cancellation.

Never forward an upstream credential to a caller-supplied URL or blindly follow
redirects that could carry it to another origin. Unknown paths and providers
are rejected. Preserve provider errors without exposing credentials or
internal filesystem paths.

Automatic account switching is deferred. When added, only an explicit upstream
rejection known to be safe to retry can permit another attempt. An ambiguous
network failure or interrupted generation must not silently replay work.
Conversation affinity remains constrained by the client's current permissions.

## Hardening baseline

- Default listeners bind explicitly to loopback. Local requests still require
  authentication; loopback alone is not an authorization mechanism.
- Generate high-entropy gateway tokens; persist hashes and support revocation.
  Use standard cryptographic primitives and safe comparisons.
- Administration has a separate credential/capability. Browser mutations need
  CSRF protection and exact Host/Origin checks; DNS rebinding is in scope.
- Embedded dashboard assets ship with the service. Avoid remotely fetched
  scripts, runtime plugin loading and arbitrary HTTP administration tools.
- The dashboard receives metadata, never provider credentials. Secret
  enrollment/reveal, if needed, has a deliberately bounded one-time flow.
- Bound body/header sizes, active requests, queues and helper output. Bound
  header/connection setup, refresh and shutdown; stream liveness policy must
  accommodate long inference without allowing abandoned work indefinitely.
- Logs contain metadata and bounded sanitized errors. Prompt/response bodies,
  authentication headers, token files and helper environment values stay out
  of logs, including failure paths.
- Run as an ordinary user. Use private state directories and restrictive file
  permissions on Unix; document equivalent ACL handling before Windows support.
- Spawn approved CLI executables with explicit arguments and a controlled
  environment. Do not interpolate user data into shell commands.

Reading upstream bearer credentials necessarily makes the router a trusted
process. These controls do not claim to protect credentials from a compromised
OS or arbitrary malicious code already running as the same user.

## Dashboard and desktop

The planned YA integration starts with versioned HTTP over an owner-only local
Unix socket. Its scoped integration credential is separate from inference
credentials and permits metadata, own-pool management and session allocation
within an explicit account grant. YA's server holds it privately; UI clients
use YA's existing authenticated transport. Local socket permissions are the
bootstrap boundary, not protection from a malicious process under the same
OS user. Pairing/revocation/recovery semantics still need implementation.

Keep inference on loopback HTTP for native clients. YA and the CLI do not need
control WebSockets. UIs use a separate [message protocol](dashboard.md#app-protocol)
over a private socket (desktop) or a loopback WebSocket (browser). HTTPS
remote control and Windows named-pipe parity are later capabilities. Control operations must not appear on the inference
listener. See [the cross-repository plan](plan.md#yep-anywhere-integration).

`aar serve` runs an embedded web dashboard on a separate loopback listener with
the desktop's UI: accounts, pools, connections, live traffic and observed usage.
It signs browsers in with single-use links and enforces exact Host and Origin.
Initial account login can remain a documented terminal command while a native
launcher is absent. Launching an OS terminal from a headless service is an
optional platform adapter, not a core requirement.

A later Tauri tray app can supervise the service, open the dashboard, launch
login terminals and manage login-at-startup. Adopt Desktop Release Kit's
contracts and validation primitives with this product's own identity and
updater key. Bundle a pinned Node runtime and compiled service in one release;
update them together. Headless operation stays independent of the shell.

## Deliberate scope limits

The current prototype has no plugins, third-party provider relays,
cross-provider translation, local tokenizer tables, prompt rewriting,
arbitrary proxy targets, remote
administration or public listener exposure. Broader multi-account scheduling,
private-network enrollment and desktop distribution follow successful auth
and wire-compatibility evidence.
