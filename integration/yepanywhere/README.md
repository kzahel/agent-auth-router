# Yep Anywhere integration tests

This suite lives in AAR and runs its current sources against the exact YA commit
in [pin.json](pin.json). The YA checkout is unmodified. Both projects run in
separate Node processes, using real YA HTTP routes, metadata persistence,
supervisor, native Claude/Codex adapters and AAR's control and inference servers.

The two external boundaries are synthetic: [fake-cli.mjs](fake-cli.mjs) speaks
the Claude SDK and Codex app-server protocols, and a loopback upstream streams
deterministic responses. One wrapper around the native adapter's `startSession`
injects a failed launch after allocation. These tests do not run the official
CLIs, paid inference, OAuth login or renewal. They prove integration behavior at
the pinned revision, not compatibility with future CLIs or upstream APIs.

## Run

On macOS or Linux, with Node 24+, npm and git:

```sh
npm ci
npm run integration:prepare
npm run test:integration
```

Preparation needs network access. It fetches the full SHA into the ignored
`artifacts/yepanywhere` directory, verifies the repository origin and revision,
installs YA's frozen lockfile with its pinned pnpm version, and builds YA's
shared package. It refuses to overwrite a dirty checkout. The test command
checks the revision and clean checkout again; it never fetches a moving branch.
The ordinary AAR `npm run check` remains independent of this checkout.

Runtime uses fresh temporary AAR and YA homes, isolated credential files,
sanitized child environments and ephemeral loopback listeners. No user profile
or installed provider CLI is used. A Node socket tripwire catches accidental
non-loopback TCP connections; it is not an OS sandbox. Children and their process
groups are terminated and temporary profiles are removed on success or failure.
Failure diagnostics redact derived AAR tokens. No profiles or credential state
are uploaded by CI.

## Coverage

Each provider exercises:

- Pairing, account/catalog discovery and manual selection among two accounts.
- Real native launch overrides, overriding poisoned direct-auth environment
  variables, streamed replies and YA's persisted transcript reader.
- Provisional-to-native session ID remapping and continuation under one binding.
- Restarting both servers and resuming with the same allocation and token.
- No native launch or account fallback when AAR is unavailable or the selected
  account is disabled.
- Interrupting an unfinished response, closing its upstream connection, then
  continuing with the same committed binding.
- Failed native launch cancellation and rejection of its inference token, plus
  durable cancellation retry after control recovers and the account is disabled.
- Disconnect invalidating a running worker's token and surviving restart.
- Pending disconnect surviving a YA restart, blocking launches and re-pairing,
  explicit retry after AAR recovers, and refusal to adopt an old session into a
  new pairing.
- Provider credential substitution only at AAR, private YA storage permissions,
  no credentials in logs, transcripts, public responses or metadata, and unchanged AAR credential
  fixtures with no auth files copied into YA's native homes.

The network tripwire also has focused tests for Node's socket argument forms.
CI runs the suite on both Linux and macOS. UI behavior, official CLI compatibility,
credential renewal, automatic pools and balancing remain outside this suite.

## Update the YA pin

Choose a reviewed YA commit, update the full 40-character `revision` in
[pin.json](pin.json), and match `packageManager` to that commit's `package.json`.
Run preparation, the integration suite and AAR's normal checks. Review protocol
fixture changes alongside the YA changes that require them, then commit the pin
and any fixture updates together. Do not patch the cached YA checkout to make a
test pass; fix and pin a new YA commit instead.
