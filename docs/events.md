# Event log for later analysis

Status: implemented 2026-10-06, synthetic fixtures only. The log exists so
that questions about routing policy can be answered from recorded evidence
later, without having designed the analysis first. See
[routing policies](routing-policies.md) for the questions it is meant to
serve: when each account's windows actually reset, how much of a window one
session consumes, and what an automatic policy passed over and why.

## What is recorded

The router appends one JSON object per line to
`<state>/events/<YYYY-MM-DD>.jsonl`, named by UTC date. Every line carries
`v` (format version, currently 1), `type` and `at` (ISO time). Types:

| Type | When | Fields beyond the common ones |
| --- | --- | --- |
| `router` | the control socket is up; the router closes | `action` (`start`/`stop`), `routerId`, `pid`, `accounts` |
| `quota` | a usage probe returns, or a proxied 2xx carries rate-limit headers | `accountId`, `provider`, `source` (`probe`/`inference`), `requestId` (inference only), `windows` as the normalizer produced them: `bucket`, `windowMinutes`, `usedPercent`, `remainingPercent`, `resetsAt` |
| `rejection` | a provider answers 401, 403 or 429 | `accountId`, `provider`, `status`, `retryAfter`, `requestId` |
| `cyber-access` | upstream headers arrive for a Codex `/responses` request with an explicit recognized cyber program | `accountId`, `model`, `program`, `status`, `requestId` |
| `request` | a proxied request ends | the dashboard's request entry: `requestId`, `startedAt`, `endedAt`, `client`, `accountId`, `provider`, `poolId`, `bindingId`, `sessionId`, `route`, `model`, `status`, `outcome`, `bytesUp`, `bytesDown`, `usage`, `estimated` |
| `binding` | a session binding is prepared, committed, cancelled, or a pool prepare is refused | `action`, `bindingId`, `integrationId`, `accountId`, `provider`, `model`, `poolId`, `policy`, `state`, `createdAt`, and for pool prepares the stored `reason`, `selectionEvidence`, `observedAt` and `candidates` |

`quota.windows` holds only the windows that read reported. An inference
response carries the shared windows, so Claude's model-family weeklies still
come from probes; the merged view the pool logic uses is not duplicated here.

`binding.candidates` lists every pool member at prepare time with its
`eligibility` reason (the overview's reasons plus `thinking-unsupported`),
its `rank` among eligible accounts (null when ineligible), and its selection
evidence: `headroomPercent`, `limitingBuckets`, `reservations`, `catalogAt`,
`quotaAt`, and the Weekly pace fields `shortHeadroomPercent`,
`shortProjectedHeadroomPercent`, `shortBurnPercentPerHour`, `weeklyUnstarted`
and `weeklyPacePercent`. A refused prepare records the same list with the `error`
message and the `requestedAccountId` for Manual. Replays of an existing
binding are not recorded, and expiry of a prepared binding is not an event;
derive it from `createdAt` plus the five-minute window.

### Codex cyber access outcomes

`cyber-access` records each HTTP attempt for `access_programs.cyber` equal to
`standard`, `daybreak_blue` or `daybreak_red`. These are inference wire values;
YA's `daybreak-blue` setting becomes the app-server's `daybreakBlue`, then the
inference request's `daybreak_blue`. Metadata comes from the bounded decoded
request, including client-compressed requests. The router records the selected
enrollment ID, not an account identity supplied by the client.

Group by account, model and program: one account's refusal does not establish
another account's eligibility, nor the same account's eligibility for another
model or program. Retain both 403s and later HTTP successes so a change after
sign-in is visible. Authentication and program entitlement are separate:
token-logged-in accounts can still be refused. An HTTP 403 with an explicit
program is a refusal observation, not proof of its cause or permanent loss of
access. A 2xx records HTTP acceptance, not successful stream completion or a
guarantee of future entitlement. Other statuses retain their numeric meaning.

Join `requestId` to `request` for the client, binding and session. A router 401
recovery can produce multiple attempts with the same request ID. Events use
the ordinary log retention and buffering; disabling the log disables this
tracking. No prompt, error body, token or login-method guess is retained.

This is passive tracking, not an enablement operation or a routing policy.
Requests YA or Codex suppresses before inference, failures before upstream
headers, and failures within a 2xx stream are not captured as cyber outcomes.
Unknown program values or requests without a bounded model ID are not recorded.
YA's current per-worker denial memory remains independent of this history.

**Design decision:** record outcomes at AAR's inference boundary rather than
accepting client-reported account health: AAR knows which enrolled credential
served the request, and existing event history preserves observations across
worker and router restarts without creating a permanent eligibility blacklist.

### Session identifiers

`request.sessionId` is the client's own session id, so a request can be
joined to the CLI's rollout file and to Yep Anywhere metadata:

- Codex: the `session_id` request header, which the router already forwards.
- Claude Code: the session UUID inside `metadata.user_id`
  (`user_<hash>_account_<uuid>_session_<uuid>`). This is a source observation
  of the CLI versions in [the prototype notes](prototype.md), not a documented
  contract. The router searches the body for that one field and keeps only
  the session UUID.

`request.bindingId` is the control binding whose credential served the
request. Together with the `binding` events this attributes requests to a
pool decision. Legacy gateway clients have no binding.

## What is deliberately not recorded

No prompt or response content, token hashes, control or gateway credentials,
provider secrets, profile paths, or the binding's idempotency key (it embeds
the token hash). Reset events are not derived at write time; the raw
observations are enough to find them offline, and the rules are better
checked against data before being fixed in code.

## Mechanics

- Default on. `AAR_EVENT_LOG=0` (or `false`, `off`, `no`) disables it for any
  mode, and `aar serve --no-event-log` disables it for that run. The desktop
  app's `desktop-serve` follows the environment variable.
- Lines are buffered in memory and appended every five seconds and on
  shutdown. At most 5,000 lines wait; beyond that the oldest are dropped and
  the count is logged once. A crash can lose the last few seconds.
- The directory and files are private (0700 and 0600). A day file that is a
  symlink, not a regular file, not owned by this user, or group/world
  accessible disables the log for the process with one log line.
- Day files older than the history retention (30 days unless changed on the
  Settings tab, or forever) are deleted at startup, daily, and when the retention changes.
  Nothing else in the directory is touched.
- Writing is best effort. A failure disables the log and never affects a
  relay or an admission.

## Reading it

Each day's file is independent. A short script can concatenate days, filter
by `type`, and join `request` rows to `binding` rows by `bindingId` or to
`quota` rows by `requestId`. For per-session consumption, group `request`
rows by `sessionId` and compare the `quota` rows observed on either side.

## Verification

`test/events.test.ts` covers: UTC day files and permissions, buffering and
flush on close, retention, refusing a symlinked day file, the bounded buffer,
the environment switch, session id extraction for both providers, and an
end-to-end run through a pool prepare, refusal, commit, inference with
rate-limit headers, a 429, cancellation and shutdown, asserting the event
order, the request/quota join and the absence of secrets in the files. The
Claude `metadata.user_id` shape is a synthetic fixture; it has not been
checked against captured traffic.

`test/cyber-access.test.ts` exercises two Codex accounts through the running
router and synthetic upstream, including zstd request bodies, program/model
separation, a later HTTP success, request joins and secret exclusion. It also
checks that absent, unrecognized or malformed selections do not create cyber
observations. These checks use synthetic credentials, with no live inference.
