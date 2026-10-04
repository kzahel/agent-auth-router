# Agent Auth Router desktop

Mac-first Tauri app with a bundled Node 24.19.0 runtime and the independently
runnable TypeScript core. The UI never reads owner tokens or provider files.
Requires macOS 13.5 or newer, matching the pinned Node binary's minimum OS.
The Rust bridge invokes the bundled CLI through private local IPC. Accounts,
pools, grants and sessions live in the same default state directory as `aar`.

## Use

The compact window has Accounts, Pools, Connections and App tabs. Appearance
follows the system's light/dark theme, including changes while the app is open.
Accounts keep Sign in and Refresh usage visible; **More** holds sign-in checks,
nickname editing and disable/retire actions. CLI setup help is under **Account
setup**, and launch/update/stop controls are on **App**.

1. Open the app. It attaches to an available local router or starts its core.
2. Choose **Check installed CLIs**, then **Add account**. Select a profile folder
   (or let AAR create a dedicated one) and an optional nickname. The folder is
   the primary label. **Edit nickname** changes or clears the label without
   moving the folder or changing routing identity. Mac Claude profiles use
   their profile-scoped Keychain entry; Codex uses its dedicated file store.
3. **Sign in** opens Terminal with that profile and a clean provider environment.
   Choose browser or device-code login for Codex, subscription or SSO login for
   Claude, then follow the official CLI prompts. The CLI has interactive input
   and output; AAR does not capture that output in the app. **Check sign-in**
   distinguishes readable stored credentials from expired ones. **Cancel sign-in**
   stops the terminal login; closing the terminal also cleans up the official
   login process. Login has a ten-minute deadline and excludes renewal and core
   stop/update until it finishes. No inference is needed to sign in.
4. Create a single-provider Work pool. Manual chooses an account explicitly;
   Round robin requires fresh model and quota evidence. Use **Refresh usage**. Bars show quota remaining: 100% is full, 0% is empty.
5. Connect YA, then use **Manage access** here to grant YA the Work pool. Reload
   YA's overview. Account and membership changes need no restart or re-pairing.

Disabling an account, removing pool membership, deleting a pool or revoking a
grant blocks subsequent requests on affected pins; accepted streams may finish.
**Retire** permanently reserves the old account ID and retains its credential
profile. Re-enable a disabled account when appropriate; retired IDs cannot be
reused. No operation implicitly deletes provider credentials.

Closing the window hides it to the tray. **Quit App (Keep Router Running)**
leaves routing available. **Stop router** is explicit and refuses active
requests, metadata reads, renewal or sign-in work. Reload starts it again.
Updates download signed bytes and require an idle core before installation and
relaunch. A failed installation offers restart through Reload. A crashed router
may leave a socket: the app refuses to unlink an endpoint whose ownership it
cannot establish. Inspect it before removing stale state.

## Develop and check

From the repository root:

```sh
npm ci
npm ci --prefix desktop
npm --prefix desktop run dev
npm --prefix desktop run build
npm --prefix desktop run check
(cd desktop && npx playwright install chromium && npm test)
node desktop/scripts/verify-package.mjs 'desktop/src-tauri/target/release/bundle/macos/Agent Auth Router.app'
node desktop/scripts/smoke-installed.mjs 'desktop/src-tauri/target/release/bundle/macos/Agent Auth Router.app'
```

`AAR_STATE_DIR` selects an isolated profile. The installed smoke runner always
uses its own temporary directory and reaps the shell and router. It removes
system Node from `PATH` and verifies enrollment, retained core after app exit,
attachment and explicit Stop. Browser tests use bundled Playwright Chromium,
48 synthetic accounts and per-keystroke latency assertions during reload.
`AAR_UI_CAPTURE_DIR` retains screenshots for inspection.

The package script checks committed SHA-256 pins before extracting Node and
includes Node's license. `build.json` records application/core/runtime/source
identity and the core digest; dirty local builds are labeled. Native startup,
credentials, process control and packaging are OS adapter boundaries. Windows
runtime/ACL/process-tree/startup/update acceptance is still future work.

The [embedded sign-in terminal plan](../docs/router-owned-pools-and-desktop.md#embedded-sign-in-terminal-direction-2026-10-04)
records xterm.js as the intended Windows/Linux and eventual shared sign-in UI.
The plan includes supported terminal presentations in the same build, selectable
at runtime, while retaining the current macOS Terminal.app path. Separately,
Windows enrollment is planned to select native Windows or a WSL distribution/user
and an existing or dedicated profile. Embedded rendering, runtime selection and
Windows/WSL account support are not implemented yet; no build flag is planned.

## Candidate signing and updates

`.github/workflows/desktop.yml` checks both Mac architectures on pushes and PRs.
A manual **signed** run builds Developer ID signed, notarized, stapled app/DMG
and signed updater archives. It uploads immutable Actions artifacts and their
hashes; it does not create tags or publish GitHub releases.

Configure these repository secrets through private publisher infrastructure:
`MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`,
`MACOS_KEYCHAIN_PASSWORD`, `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`,
`ASC_API_ISSUER_ID`, `TAURI_SIGNING_PRIVATE_KEY`, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Repository variables:
`MACOS_SIGNING_IDENTITY`, `APPLE_TEAM_ID`. The updater key is unique to AAR.
No private material, machine inventory or signing handoff belongs in this repo.

To validate and upload an existing Developer ID certificate/password pair on
macOS, after configuring `APPLE_TEAM_ID` and authenticating `gh`:

```sh
node desktop/scripts/upload-macos-certificate.mjs --p12 /path/to/publisher.p12 --set
```

The helper takes the export password through a hidden local dialog, verifies
the container password, publisher identity and certificate validity, then sends
both secrets to GitHub through stdin. Omit `--set` for validation only. It
preserves the app's updater key and the other signing credentials. This follows
the validate-before-upload procedure referenced by Desktop Release Kit; CI
still establishes certificate import, signing and notarization acceptance.

Product identity is `com.graehlarts.agent-auth-router`; the product-owned update
configuration is [agent-auth-router.json](../update-server/agent-auth-router.json).
Register that configuration with the shared update service before publishing.
The app checks after five seconds and every 24 hours, coalesces checks, retains
an available update after transient errors, and installs only on user action.
Candidates do not appear on the stable update route. Public release publication
and an actual signed older-to-newer installed update require separate acceptance;
a successful build or local smoke is insufficient.

References: [Desktop Release Kit](https://github.com/kzahel/desktop-release-kit),
[Machine Control](https://github.com/kzahel/machine-control/tree/main/desktop),
and [Lid Awake](https://github.com/kzahel/lid-awake). The signing sequence adapts Machine Control; its MIT notice is retained in
[NOTICE](NOTICE) and [MACHINE-CONTROL-LICENSE](MACHINE-CONTROL-LICENSE).
