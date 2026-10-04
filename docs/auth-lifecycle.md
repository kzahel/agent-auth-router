# Credential lifecycle and refresh experiment

Status: credential readers and coordination are prototyped and fixture-tested;
dedicated login/read access and one native proxy turn per provider were verified.
Durable renewal remains unverified for both providers. See the versioned
[prototype observations](prototype.md).

## Initial enrollment

Create a dedicated account home for the chosen provider. The user signs in
using the installed official CLI through its browser or device-code flow.
On macOS a future Add account button can launch that command in a terminal.
Headless operation provides the command for the user to run.

The login process uses `CODEX_HOME` or `CLAUDE_CONFIG_DIR` and direct provider
configuration. Gateway URL/token overrides must be absent from both the
environment and effective configuration. Do not change the user's global
configuration as part of enrollment.

After completion, establish the storage backend and account identity through
narrow supported interfaces or a version-specific reader. Merely finding a
file or observing login status does not establish live upstream access.

Keep initial CLI login separate from client configuration: clients authenticate
to the router with gateway tokens; profile homes contain upstream logins.
The router cannot infer the selected home from a client's bearer header.

## Refresh ownership

The router owns scheduling and coordination. The official CLI owns token
exchange and persistence. The router reads the resulting access credential;
it does not copy and restore token bundles or mutate refresh tokens.

For each account:

1. Read observed expiry and the current credential revision, retaining only
   necessary secret material in memory.
2. When renewal is due, acquire that account's helper lock and reread storage.
3. If another managed helper already produced usable credentials, reuse them.
4. Otherwise invoke an approved CLI operation with that profile, a clean
   direct-provider configuration and bounded lifecycle.
5. Wait for completed persistence. Reread and verify the resulting access
   credential and expiry; exit status alone is insufficient.
6. Release waiting requests only when a usable credential exists. On failure,
   surface the actual condition, with bounded backoff and no busy loop.

The CLI's own refresh threshold matters. Running well before expiry may leave
the credential unchanged. Handle sleep/wake and service restart by checking
current state before routing; background timers alone cannot guarantee renewal.
Inactive accounts should not cause indefinite background helper activity.

The current coordinator checks expiry on demand, with a configurable renewal
window defaulting to five minutes. There is no background keep-warm loop. A
failed due renewal can leave an unexpired credential usable with backoff;
forced 401 recovery requires a different readable credential. An expired
credential without a helper requires official CLI login. These paths are
fixture-tested, not proof of real provider renewal.

An upstream 401 may indicate early invalidation rather than ordinary expiry.
Recheck storage and allow one coordinated recovery attempt where replay is
known safe. Never turn authentication recovery into an unbounded replay loop.
Revoked or exhausted refresh credentials require interactive login.

## Helper selection and current findings

Prefer an auth-only official operation that completes renewal and persistence.
Codex app-server account/auth methods are worth evaluating before paying for
a maintenance inference. Inspect the installed version's protocol and prove
its behavior; legacy method names and current source may differ.

The implemented Codex helper reads cached account state, then requests
`account/read {"refreshToken": true}`. In the recorded Codex 0.159.0
experiment, forced refresh returned no account after cached state had recognized
the login; stored credentials did not change. The helper classifies that result
as failed/unverified renewal, rather than assuming an unexpired login is revoked.
Ordinary automatic renewal when due has not been verified. Quota reads use
`account/rateLimits/read` separately and do not request forced renewal.

`codex login status` in the inspected source only loads and reports cached
authentication. Opening a terminal, starting a CLI and killing it, or running
a status command is not evidence of durable renewal.

OpenAI documents a normal-run-and-persist pattern for private Codex automation.
A small ordinary run is a fallback experiment, but it may consume subscription
usage and must be deliberately authorized for testing. It is not necessary to
run a full agent for every proxied request.

Claude's exact invocation remains unresolved. A recent upstream issue reports
short-lived commands initiating rotation and exiting before persistence. Treat
that as a reported failure mode to test, not as a reproduced finding here.
Allow successful refresh to finish rather than terminating based on a short
fixed sleep.

If a helper invokes inference, run it in a neutral working directory with
provider-supported restrictions on tools, MCP, plugins and project discovery.
Dedicated profile settings must not inherit unrelated user automation. Prove
what runs and what is billed rather than assuming a tiny prompt is harmless.

## Storage and concurrency

- Codex supports file, OS credential-store and other storage modes. Choose
  and document one mode per tested host; do not assume `auth.json` exists.
- Claude storage on macOS uses a version-specific, profile-derived Keychain
  service in the tested 2.1.280 runtime. An explicitly enrolled
  `claude-keychain` reader selects only that service and OS account, bounds
  output/lifecycle and discards stderr. The dedicated live read succeeded;
  broader version/platform behavior and renewal remain unverified. File storage
  remains the default, with no automatic Keychain enumeration or fallback.
- Readers must tolerate credential replacement, temporary writes and malformed
  state without truncating or repairing the provider-owned store.
- File permissions depend on the actual writer and existing directory. Verify
  restrictive access after enrollment; do not infer it from API defaults.
- Only managed, serialized helpers write a profile. Dedicated directories do
  not make two copies of the same refresh credential independently safe.
- Router cache invalidation must reread the authoritative store after refresh,
  restart and relevant upstream authentication failure.

## Intended observable states

Accounts should distinguish: not enrolled, ready, renewing, temporarily
unavailable and login required. Show sanitized errors and last successful
renewal. A healthy status must reflect a usable credential, not merely a file
timestamp or a successful helper launch.

The current coordinator's `ready` state means a locally usable credential,
not a fresh provider health check. Its renewal/error/backoff metadata is
process-local. There is no persisted account-health dashboard or control API.

Gateway-token revocation and provider-account expiration are separate states.
Upstream token rotation must not require changing a client's gateway token.

## Decision after the experiment

If both providers support reliable delegated renewal, keep the router read-only
with respect to provider credentials. If a provider lacks a usable helper,
document the evidence and alternatives: manual renewal, an official credential
broker, or explicit router-owned OAuth. None is silently selected by this plan.

Links to the upstream code, official guidance and reported Claude issue are
maintained in [sources](sources.md).
