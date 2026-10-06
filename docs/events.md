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
| `request` | a proxied request ends | the dashboard's request entry: `requestId`, `startedAt`, `endedAt`, `client`, `accountId`, `provider`, `poolId`, `bindingId`, `sessionId`, `route`, `model`, `status`, `outcome`, `bytesUp`, `bytesDown`, `usage`, `estimated` |
| `binding` | a session binding is prepared, committed, cancelled, or a pool prepare is refused | `action`, `bindingId`, `integrationId`, `accountId`, `provider`, `model`, `poolId`, `policy`, `state`, `createdAt`, and for pool prepares the stored `reason`, `selectionEvidence`, `observedAt` and `candidates` |

`quota.windows` holds only the windows that read reported. An inference
response carries the shared windows, so Claude's model-family weeklies still
come from probes; the merged view the pool logic uses is not duplicated here.

`binding.candidates` lists every pool member at prepare time with its
`eligibility` reason (the overview's reasons plus `thinking-unsupported`),
its `rank` among eligible accounts (null when ineligible), and its selection
evidence: `headroomPercent`, `limitingBuckets`, `reservations`, `catalogAt`,
`quotaAt`. A refused prepare records the same list with the `error`
message and the `requestedAccountId` for Manual. Replays of an existing
binding are not recorded, and expiry of a prepared binding is not an event;
derive it from `createdAt` plus the five-minute window.

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
- Day files older than 90 days are deleted at startup. Nothing else in the
  directory is touched.
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
