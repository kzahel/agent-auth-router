# Agent guided setup and diagnostics

Status: implemented in source with synthetic acceptance, 2026-10-15.
Supervised real Claude/Codex login acceptance remains pending. The current
contract and commands are in [diagnostics](diagnostics.md); this document
retains the implementation direction and live acceptance criteria. It replaces
the earlier conversational proposal for a structured provider-login parser
with an agent-operated tmux workflow.

The setup skill teaches an agent to enroll accounts and configure access while
watching and driving the official CLI in a real terminal. The agent observes
each prompt and adapts its next action; the user completes browser sign-in,
account selection and consent. A consolidated diagnostic report supplies
reliable local facts before and after that interaction.

## Scope and existing foundations

The core remains headless Node/TypeScript with no runtime dependencies. tmux
is a prerequisite for this agent-guided workflow, not a router dependency.
Initial acceptance covers macOS/Linux where tmux is available; native Windows
support is not established by this work.

Current source already provides:

- [Owner operations](owner-management.md) for profile discovery/inspection,
  enrollment, sign-in status, cancellation, pools and grants.
- [`terminal-login <id>`](../src/terminal-login.ts), dispatched by
  [the CLI](../src/cli.ts), with a real TTY, isolated provider environment,
  a per-account login lease, a ten-minute deadline and cancellation. The
  official CLI inherits terminal input/output. The router must remain running.
- [Account actions](../ui/src/accounts/AccountCard.tsx) for sign-in, status,
  quota refresh and errors, plus [installed CLI checks](../ui/src/accounts/AccountsTab.tsx).
- [Credential coordination](../src/coordinator.ts), cached pool evidence,
  allocation reasons and metadata-only traffic history.

The earlier prototype and planning documents contain historical limitations;
use current source and the owning contracts above for this work. Successful
login, successful provider metadata reads and verified credential renewal are
different observations; preserve the distinction in all reports.

No allocation-policy changes, account switching, exhaustion recovery,
router-owned OAuth, credential export/import implementation, or YA auxiliary
inheritance implementation is included. The latter is captured separately in
[YA's inheritance gap](../../yepanywhere/gaps/routed-auxiliary-launch-inheritance.md).

## Diagnostics shared by CLI, skill and management UI

Add one diagnostic engine, rather than independently reimplementing checks in
each caller. Reuse existing configuration validation, provider-version probes,
profile checks, coordinator state and pool/grant evidence. Diagnostic reads
must not reuse an administration path that implicitly starts a temporary router.

CLI surface:

| Command | Effect |
| --- | --- |
| `aar doctor` | Inspect installation, CLI availability/versions, configured profiles and stores, router reachability, configuration and pool/grant consistency; include cached health when available. |
| `aar doctor --account <id> --check-login` | Also read that enrolled credential store through the supported reader and report sanitized sign-in state. |
| `aar doctor --account <id> --refresh-usage` | Explicitly run the existing bounded provider metadata checks. The official CLI may renew credentials as part of this operation. |
| Any of the above with `--json` | Return the same findings in a versioned machine-readable report. |

Default diagnostics read no provider credentials, contact no provider and do
not start or repair a stopped router. CLI version probes use the existing
bounded, isolated subprocess approach. Offline checks leave files, permissions
and sockets unchanged; unsafe or corrupt state produces a finding, not a fix.
Local credential checks require the selected account. Metadata refresh remains
explicit and bounded; no inference or forced-renewal experiment is part of doctor.

Each finding has a stable code, status (`ok`, `warning`, `error`, `unknown` or
`skipped`), affected local object, observation time, plain explanation and a
known next action when one exists. Actions name supported operations; JSON
does not supply arbitrary executable repair commands. Include scope/mode and
report version so agents can distinguish an unchecked account from a failed one.

Important classifications:

- A stopped router is distinct from an invalid installation or broken login.
- Stale/unknown quota is distinct from exhaustion and model incompatibility.
- An expired access token is not automatically a lost login. Preserve the
  existing ready/idle/renewing/renewal-failed/login-required distinctions.
- Readable credentials establish local sign-in evidence, not successful
  provider access. A quota read proves that metadata operation only.
- Renewal observations report their timestamps and lifetime. Process-local
  coordinator history must not appear to survive a restart.

Return useful partial findings when an individual check fails. Set finite
subprocess/provider and overall deadlines; share existing coalescing/backoff
for explicit metadata checks. No idle diagnostic polling is added. Use exit 0
when no actionable error is found, 1 for actionable findings and 2 when the
report cannot be produced reliably or arguments are invalid. Unknown/skipped
checks remain explicit even when exit status is 0.

Expose the shared report through an owner-only operation and the authenticated
management app protocol. The management UI offers Run diagnostics and Copy
report; actionable findings link to existing account/pool operations. Copy
report omits absolute paths, account emails, credentials, login URLs/codes and
raw provider/helper output. Local detail views may show the already-authorized
profile path. Reports are generated on demand, not persisted as new health logs.

## Setup skill and tmux interaction

Keep the skill source in `skills/agent-auth-router/SKILL.md`, with a small
optional migration reference for less common tasks. Document how to install
the skill into the agent's skill directory; do not silently install it during
normal router startup. Do not add a login-driving script or expect-style
prompt matcher. Deterministic router operations and structured diagnostics
remain ordinary commands; conversational login decisions belong to the agent.

The skill should explain the following adaptable flow, not prescribe an
unconditional sequence of keystrokes:

1. Establish which machine/router/state directory the user means. Check tmux
   and the agent's ability to inspect panes and send input, then run passive
   diagnostics. If tmux is missing, explain the prerequisite and offer setup;
   do not silently switch to a blind headless login parser.
2. Show existing enrollment metadata and ask for provider/profile labels as
   needed. Prefer dedicated profiles; existing-profile enrollment is an
   explicit choice. Reuse enrollment/status checks after interruptions.
3. Ensure the intended persistent router is running before managed login.
   Start one account's `aar ... terminal-login <id>` in a dedicated tmux pane,
   using the correct state directory. Record its exact session/window/pane
   identity, verify the displayed provider/profile, and give the user an
   attach instruction. Never target a peer's pane or an unspecified active pane.
4. Inspect the pane before choosing input. Read the menu or current provider
   prompt and send the next input only when its meaning is understood. Inspect
   again after each transition. Menu numbers, prompt text, URL shape and timing
   are observations, not a fixed script. Use bounded waits between inspections;
   never queue a whole login sequence in advance.
5. Relay the official sign-in URL and user-facing device code when present.
   The user performs browser authentication, MFA, account choice and consent.
   If the CLI asks for a browser-returned code, follow the actual instructions
   and prefer direct terminal entry for sensitive input. Do not ask the user
   to paste credentials or token bundles into chat.
6. After the user acts, inspect the pane to see whether login completed,
   failed, expired or needs another step. An unfamiliar prompt calls for
   reading installed CLI help or asking the user what is needed. Never guess
   at destructive choices or bypass official CLI ownership to make progress.
7. Verify the selected profile with the sanitized credential check in a fresh
   process. An agreed usage/catalog refresh can establish metadata access;
   do not send a model prompt. Configure the requested pool/client/integration
   access through existing owner operations, then show a concise status table.

The existing terminal runner provides the TTY, isolated environment, lifecycle
lease and termination bounds. Promote/document its CLI entry point if needed,
and add small status/cancellation conveniences only when actual use shows a
gap. A new machine-readable provider prompt protocol, mandatory login-method
flags and device-code output parser are not prerequisites.

tmux makes the interactive process visible and reattachable; it does not make
it unlimited. Teach the agent to recognize the runner's timeout, cancel through
supported operations, wait for process exit, and check status before retrying.
Manage only panes/processes created for this task. Detaching and cancelling
are different actions. Remove owned panes and their scrollback after completion
or cancellation without terminating unrelated tmux sessions. No pipe-pane,
terminal recording or raw-output evidence files are part of the workflow.
Capture only the necessary recent pane content; never dump credential stores.

Process one account at a time and checkpoint between accounts. Existing
successful enrollment/login should be reused, not repeated to reconstruct the
conversation. Choose only the requested access grants. Preserve existing
normal CLI profiles and unrelated configuration. Gateway tokens belong in the
intended client's private configuration, not in the final chat summary.

The migration reference explains:

- Enrolling an existing profile versus copying its credential store.
- Why concurrently used copies of OAuth refresh state can diverge; dedicated
  folders alone do not coordinate copied credentials across machines.
- Fresh official login on each intended auth host, or clients sharing one
  central router, as understandable deployment choices.
- Portable settings versus machine paths, tokens, router identities and
  durable bindings; stop writers before restoring a consistent router backup.
- Which cleanup keeps credentials and which removes a profile. Never log out
  an unrelated profile or delete a successful account as automatic test cleanup.

## Verification and acceptance

### Automated checks for deterministic boundaries

Use synthetic state, fake credentials and fake provider CLIs only. Tests cover
observable security/lifecycle behavior, not the skill's wording:

- Default doctor performs no credential reads, provider calls, helper renewal,
  router startup or state mutation, including missing/corrupt/offline state.
- Findings retain partial results, age/source and truthful unknown/error
  classifications. Inject secrets into fixtures and verify JSON, text and
  copied reports exclude them.
- Explicit checks stay account-scoped, use existing storage selection and
  metadata bounds, and respect current grants and backoff where applicable.
- The existing TTY test already covers both provider method choices, profile
  isolation, cancellation and exclusion of concurrent login/renewal. Extend it
  only for changed boundaries; do not build a second scripted login suite.
- Shared UI diagnostics retain owner-only authorization and output redaction.
  UI changes receive focused desktop/web verification, including sequential
  typing while report results arrive.

Run the repository's core typecheck/tests and applicable UI checks for the
implementation. Validate the eventual skill's metadata and links. Automated
tests cannot establish that an agent can adapt to a real login interaction.

### Agent rehearsal in tmux

Before real credentials, have the agent follow the skill against an isolated
fake CLI in a real tmux pane. It must observe and answer an extra harmless
prompt, cope with delayed output, and cancel/recover from an interrupted run.
Change the fake prompt wording/order from the example flow so a fixed sequence
would fail. The agent chooses each step from the pane; no script supplies its
answers. Use synthetic login data and record only a short outcome summary.

### Supervised live Claude and Codex acceptance

After implementation and fixture checks, run an ordinary agent session with
the skill and the user present. This is an interactive acceptance exercise,
not a CI job or an unattended login script. Run the two providers sequentially:

| Provider | Minimum live exercise |
| --- | --- |
| Claude | Agent enrolls the selected dedicated profile, starts managed official subscription login in tmux, reads/handles the current terminal prompts, relays browser instructions and waits for user authentication. |
| Codex | Agent repeats the flow for its selected dedicated profile; exercise official device authentication when supported and suitable for that environment, otherwise record the browser flow actually used. |

For each provider, the agent must:

1. Establish pre-login state, selected profile/store and CLI version without
   exposing account identity or secrets.
2. Drive the actual tmux pane incrementally, with the user able to attach and
   see the same state. Human browser actions remain human steps.
3. Observe the CLI's final result, then read sanitized sign-in status from a
   fresh process after CLI exit to establish persisted login state.
4. Perform the agreed metadata-only quota/catalog check and record its result
   separately. If unavailable, preserve successful local login evidence and
   report the precise remaining blocker instead of claiming full acceptance.
5. Finish with the requested enrollment/access table and clean up owned
   terminal resources. Retain or remove test enrollment according to the
   selected profile's purpose; do not revoke a shared provider login.

Record date, OS, router/CLI versions, provider, storage mode, login method,
sanitized observed outcome, deviations requiring adaptation and remaining
limitations. Exclude emails, profile inventory, raw tmux captures, OAuth URLs,
codes and credentials. This proves the observed setup interaction and
persistence on those versions. It does not prove future CLI compatibility,
every login method/platform, inference compatibility or durable token renewal.

The live acceptance remains pending until both supervised exercises finish.
Only synthetic credentials were used during implementation and rehearsal.

### Implementation evidence

On 2026-10-15 the full core check passed 199 tests. The UI passed typecheck,
60 tests and its production build. The authenticated web diagnostic test
passed desktop/375px phone layout, selected-account credential checks and
sanitized copy output; all 29 sequential filter keystrokes were retained,
with maximum input-to-frame acknowledgement of 7.9 ms during report arrival.
The existing tab bar now wraps to avoid phone-width overflow.

The agent manually drove the synthetic Claude and Codex CLI stand-ins through
tmux, inspecting the pane between each answer. Both completed an extra prompt
and delayed confirmation and persisted readable fixture credentials. Codex
also exercised managed cancellation (cancelled/signed-out status and runner
exit), followed by a successful retry. The owned terminal resources and router
were stopped afterwards. No provider was contacted by that rehearsal.

The skill metadata validator and reference-link checks pass. These results
establish fixture and observed agent interaction behavior, not real-provider
login or renewal. A new supervised YA session will exercise the skill with a
separate state directory and user-completed official authentication.

## Implementation sequence

1. Add the shared diagnostic engine, proposed CLI and scoped owner operation;
   verify passive/explicit-check boundaries and report redaction.
2. Document/expose the existing managed terminal entry point for tmux use.
   Fix only concrete lifecycle/usability gaps found during rehearsal.
3. Write the concise setup skill and migration reference; run the adaptive
   tmux rehearsal, then the supervised Claude and Codex acceptance exercises.
4. Expose the same diagnostic report in the management UI and verify its
   owner-only actions, readable findings and sanitized copy operation.
5. Update owning docs with implemented behavior and record exact acceptance
   evidence. Keep failed or untested cells explicit; do not replace findings
   with blanket claims that setup or renewal works.
