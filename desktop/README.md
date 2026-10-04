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
nickname editing and disable/remove actions. CLI setup help is under **Account
setup**, and launch/update/stop controls are on **App**.

Pairing from YA and external account/pool/grant edits refresh this window
automatically. The native shell checks only registry file metadata every 250 ms
and emits a local change notification; it does not poll provider quotas or read
profile credentials. Refreshes coalesce and leave open editors unchanged.
Background observation never starts a router stopped with **Stop router**.

1. Open the app. It attaches to an available local router or starts its core.
2. Choose **Check installed CLIs**, then **Add account**. Choose **Create dedicated
   profile** or **Use existing profile**. Existing profiles offer **Find profiles**
   and an optional **Check profile** preview, with an explicit storage choice.
   **Add account** validates the profile automatically and shows any failure in
   the form; a separate preview is not required.
   Reuse leaves files and permissions unchanged; readable credentials do not need
   another login. Unsupported Codex non-file storage is reported without changing
   its configuration. Select a profile folder
   (or let AAR create a dedicated one) and an optional nickname. The folder is
   the primary label. **Edit nickname** changes or clears the label without
   moving the folder or changing routing identity. Mac Claude profiles use
   their profile-scoped Keychain entry; Codex uses its dedicated file store.
3. **Sign in** opens your chosen terminal with that profile and a clean provider
   environment. **App → Sign-in terminal** offers Terminal.app (the default) or
   **Built-in terminal**; both are included in the same Mac build.
   Choose browser or device-code login for Codex, subscription or SSO login for
   Claude, then follow the official CLI prompts. The CLI has interactive input
   and output. The built-in window displays it locally without saving a transcript.
   **Check sign-in**
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
**Disable** pauses routing and can be reversed with **Enable**. **Remove** takes
an account out of the list, pools and direct integration grants. Existing session
pins stay invalid; the same folder can be enrolled again with a fresh identity.
Old retired accounts can also be removed. Retire is no longer a desktop action.

The Remove dialog keeps files by default. **Also delete the profile folder** is
unchecked and available only for dedicated direct children of the router's
profiles folder, not imported/external profiles, symlinks or shared parent
folders. It permanently deletes that folder's files, settings and history;
Keychain entries remain. The backend rechecks the account revision and folder
identity from the dialog. Removal waits for idle routing/metadata work and for
that account's sign-in/renewal to finish. A deletion failure leaves a disabled
account visible so you can inspect it or remove it while keeping remaining files.

Closing the management window hides it to the tray. Closing an embedded sign-in
window cancels that login. **Quit** stops the router, including active requests,
renewal work and sign-ins, and exits the app. Yep Anywhere connections that need
the router remain unavailable until the app is launched again. There is no
keep-running option. **Stop router** is explicit and refuses active
requests, metadata reads, renewal or sign-in work. Reload starts it again.
Updates download signed bytes and require an idle core before installation and
relaunch. A failed installation offers restart through Reload. A desktop-started router also shuts down when the app process disappears.
On relaunch, the app recovers a private abandoned control socket only after two
refused connection probes and an unchanged file identity. It preserves that inode
as `control.sock.stale-*`; live sockets, foreign owners, symlinks and ordinary
files are left untouched. Startup failures report a safe specific reason.

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
system Node from `PATH` and verifies enrollment, router shutdown after app exit,
relaunch and explicit Stop. Browser tests use bundled Playwright Chromium,
48 synthetic accounts and per-keystroke latency assertions during reload.
`AAR_UI_CAPTURE_DIR` retains screenshots for inspection.

The package script checks committed SHA-256 pins before extracting Node and
includes Node's license. `build.json` records application/core/runtime/source
identity and the core digest; dirty local builds are labeled. Native startup,
credentials, process control and packaging are OS adapter boundaries. Windows
runtime/ACL/process-tree/startup/update acceptance is still future work.

The [embedded sign-in terminal plan](../docs/router-owned-pools-and-desktop.md#embedded-sign-in-terminal-direction-2026-10-04)
records the shared terminal direction. Version 0.1.3 implements xterm.js 6.0.0
and portable-pty 0.9.0 on macOS, alongside Terminal.app, with a runtime preference.
Windows/WSL account environments and Linux packaging remain future work.

Native PTY tests exercise both provider fixtures through the real bundled helper
and router lease, plus resize, bounded output, disconnect and process-group
cleanup. The browser test checks keyboard input, theme, rendering and cancellation.
For an isolated native WebView/CSP/IPC smoke, prepare the bundle, then run:

```sh
TAURI_CONFIG='{"identifier":"com.graehlarts.agent-auth-router.smoke"}' cargo build --manifest-path desktop/src-tauri/Cargo.toml
node desktop/scripts/smoke-embedded.mjs
node desktop/scripts/smoke-lifecycle.mjs
node desktop/scripts/smoke-pairing.mjs
```

This uses a distinct app identity, temporary state and a synthetic CLI. Its
automation hook exists only in debug builds and requires the runner's explicit
synthetic-state marker. It does not authenticate with a live provider.

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
