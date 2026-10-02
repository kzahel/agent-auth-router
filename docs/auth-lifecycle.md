# Credential lifecycle and refresh experiment

Status: approach to test, not demonstrated by this repository.

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

An upstream 401 may indicate early invalidation rather than ordinary expiry.
Recheck storage and allow one coordinated recovery attempt where replay is
known safe. Never turn authentication recovery into an unbounded replay loop.
Revoked or exhausted refresh credentials require interactive login.

## Helper selection is the first research task

Prefer an auth-only official operation that completes renewal and persistence.
Codex app-server account/auth methods are worth evaluating before paying for
a maintenance inference. Inspect the installed version's protocol and prove
its behavior; legacy method names and current source may differ.

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
- Claude storage on macOS may involve Keychain entries associated with the
  configuration directory. Establish the exact current identity/format and
  access behavior for an enrolled profile.
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

Gateway-token revocation and provider-account expiration are separate states.
Upstream token rotation must not require changing a client's gateway token.

## Decision after the experiment

If both providers support reliable delegated renewal, keep the router read-only
with respect to provider credentials. If a provider lacks a usable helper,
document the evidence and alternatives: manual renewal, an official credential
broker, or explicit router-owned OAuth. None is silently selected by this plan.

Links to the upstream code, official guidance and reported Claude issue are
maintained in [sources](sources.md).
