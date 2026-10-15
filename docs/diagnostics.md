# Diagnostics and agent guided setup

`aar doctor` produces an on-demand report shared by the command line and
Settings → Diagnostics in the management UI. It runs against the selected
state directory; it never starts a stopped router or repairs its files.

```sh
aar --state /absolute/state doctor
aar --state /absolute/state doctor --json
aar --state /absolute/state doctor --account work --check-login --json
aar --state /absolute/state doctor --account work --refresh-usage --json
```

In a source checkout, substitute `node /absolute/checkout/src/cli.ts` for
`aar`. Node 24 or newer is required. Rebuild the UI with `npm run build:ui`
after changing its source; installed desktop bundles carry their own core/UI.

## What each check means

The default report checks state privacy and configuration, official CLI
availability/versions, profile directories/configuration, pool/grant/client
references and available cached health. It does not read provider credential
stores or contact providers. Version checks use an isolated profile location
and bounded subprocesses, retaining only a numeric version from their output.

`--check-login` requires `--account` and reads that account's enrolled store.
It never runs a renewal helper. Locally readable/unexpired credentials are
different from confirmed provider access. An expired access token may be idle
with renewal configured, rather than signed out. When connected, coordinator
failure/rejection state participates in the finding.

`--refresh-usage` also requires an account and a running router. It uses the
existing coalesced, bounded catalog/quota reads, including their backoff. The
official CLI may renew credentials while reading metadata. No model prompt
or forced-renewal experiment is requested. A metadata read does not establish
general inference compatibility or durable credential renewal.

Individual failures preserve other findings. Unknown, stale and skipped checks
remain visible. Explicit reads have a twelve-second report deadline; shared
metadata work may finish later within its existing provider deadline. Passive
reports add no background polling. Recorded renewal history is local to the
current router process and resets at restart.

Exit status is 0 when no actionable error is found, 1 for actionable findings,
and 2 for invalid arguments or an incomplete/unreliable report. Exit 0 can
include unknown or unchecked credentials. JSON includes report version, mode,
optional account scope, timestamps, fixed-vocabulary findings, action names,
exit status and `copyText`.

## Management UI and sharing

Settings → Diagnostics offers passive Run diagnostics, selected-account Check
sign-in and Refresh usage, filtering and links to the existing management
tabs. The app protocol enforces the same authenticated owner boundary as other
management operations; inference clients and integration credentials cannot
call the diagnostic owner operation.

Copy report uses the core's sanitized `copyText`, which replaces local account
and pool identifiers with report-local references. It excludes profile paths,
emails, credentials, raw errors and login URLs/codes. CLI JSON is local owner
output and retains local IDs for agent actions; use `copyText` when sharing.
Reports are not persisted as another health log.

## Setup skill

The repository ships [the agent-auth-router skill](../skills/agent-auth-router/SKILL.md).
An agent can read that file directly, so a supervised verification session does
not require global installation. For ordinary discovery, install or symlink
the whole `skills/agent-auth-router` directory into the agent's skills
directory, preserving an existing installation. The skill includes its own
command and migration references and creates no login-driving script.

The workflow requires tmux on macOS/Linux. The agent opens the existing
`aar --state /absolute/state terminal-login work --browser link` runner in an owned pane,
observes the actual prompts and sends each next input deliberately. The
runner maintains profile/environment isolation and its login lease. The user
completes browser account selection, authentication and consent. The agent
verifies persisted local status afterwards with a fresh doctor invocation.

The agent gives the user a sign-in link by default, without asking for a
browser preference. Opening a browser requires an explicit request and opens
it on the computer running AAR, which may differ from the user's chat device.
The agent explains this and clarifies an ambiguous "here" before opening it.
`--browser link` suppresses Claude's
browser opener and selects the official Codex device flow. `--browser open`
is explicit opt-in to the CLI's usual browser behavior. If omitted, the
runner asks and Enter chooses a link. This affects the managed terminal
runner; the legacy headless login API and raw printed CLI command do not
carry this choice and are not used by the setup skill.

The agent reports setup progress in ordinary language. Technical findings,
paths and storage details stay in diagnostics unless needed to explain a
problem or requested by the user.

For standalone verification, use a private state directory outside checkouts,
not the normal router's state or normal CLI profile. A private `config.json`
with `{"listen":{"host":"127.0.0.1","port":0}}` and `serve --no-dashboard`
avoids listener conflicts. Every AAR command must carry that same state path.
The verification needs no changes to YA's existing pairing or access grants.

The [implementation and acceptance plan](setup-and-diagnostics.md) records
synthetic verification and the separate supervised real-login acceptance.
