# Agent Auth Router

A local gateway that lets Claude Code, Codex and
[Yep Anywhere](https://github.com/kzahel/yepanywhere) share a pool of Claude
and ChatGPT subscription accounts. Clients authenticate to the router with
revocable gateway tokens; the router picks an account with remaining quota and
authenticates upstream with that account's current credential. The official
CLIs keep ownership of sign-in, credential storage and refresh.

**Platforms:** the desktop app is macOS only for now (13.5 or newer, Apple
Silicon and Intel). It is a Tauri app, and Windows and Linux builds are
planned. The headless router and `aar` CLI also run on Linux.

## Install

Download the latest DMG from
[Releases](https://github.com/kzahel/agent-auth-router/releases/latest). The
app is signed and notarized, and updates itself after you confirm.

## Quick start

1. Open the app. It starts a local router, or attaches to one that is already
   running.
2. **Accounts → Add account.** Create a dedicated profile folder, or reuse an
   existing `CLAUDE_CONFIG_DIR` / `CODEX_HOME` profile.
3. **Sign in** runs the official `claude` or `codex` login in Terminal.app or
   the built-in terminal. No inference is used to sign in.
4. **Pools → create a pool** for one provider and choose a policy: Manual,
   Round robin or Most remaining. **Refresh usage** shows quota left on each
   account.
5. **Connect Yep Anywhere**, then use **Manage access** to grant it a pool.
   Account and pool changes take effect live, with no restart or re-pairing.

Closing the window keeps the router running in the tray; **Quit** stops it.
See the [desktop guide](desktop/README.md) for details.

## How it works

```text
Claude / Codex / YA clients -- gateway tokens --> local router
                                                    |
                                      selected account access token
                                                    |
                                                    v
                                            respective provider

Official CLI helpers -- login / refresh --> isolated credential stores
                                                    ^
                                                    |
                                             router reads only
```

- Each upstream account has its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. On
  macOS, Claude accounts use that profile's own Keychain entry, never your
  normal Claude login. Codex accounts use file storage.
- When a credential is close to expiring, the router asks the official CLI to
  renew it (a no-prompt Claude Code control session, or the Codex app-server),
  then rereads the store to confirm the credential changed. The router never
  exchanges or refreshes tokens itself.
- Pools are single-provider. Sessions are pinned to an account. Quota is read
  on demand from each provider's usage endpoint, and recorded from the
  rate-limit headers of every proxied response. Nothing polls in the
  background.
- The router listens on loopback only. It forwards an allowlisted set of
  routes and headers to fixed upstream origins. Administration goes through an
  owner-only Unix control socket.

## Headless / CLI

The core is Node.js/TypeScript with no runtime dependencies and requires
Node 24 or newer.

```sh
npm install
npm run check                                   # typecheck + tests
npm run aar -- init
npm run aar -- account add work --provider claude --credential-store claude-keychain
npm run aar -- account login-command work       # run the printed official login
npm run aar -- client add laptop --claude work  # prints client configuration
npm run aar -- serve
npm run aar -- account quotas                   # quota percentages and resets (JSON)
npm run aar -- --help
```

Clients point at `http://127.0.0.1:8417/claude` or
`http://127.0.0.1:8417/codex`. State defaults to `~/.agent-auth-router`
(override with `--state` or `AAR_STATE_DIR`) and is shared with the desktop
app.

## Limitations

- The desktop app is macOS only; Windows and Linux are coming. Windows also
  lacks the control socket.
- Claude Keychain storage is macOS only. On Linux, Claude accounts use file
  storage.
- Claude usage comes from an internal OAuth endpoint observed in Claude Code,
  not a documented API, and may change without notice.
- Provider terms for subscription accounts apply. This is for routing your own
  accounts on your own machine.

## Docs

- [Desktop app guide, development and signing](desktop/README.md)
- [Router ownership and live administration](docs/owner-management.md)
- [Pools and quota](docs/pools.md) and [routing policies](docs/routing-policies.md)
- [Local integration protocol](docs/control.md)
- [Architecture and security boundaries](docs/architecture.md)
- [Credential lifecycle](docs/auth-lifecycle.md)
- [Prototype history and observations](docs/prototype.md)
- [Source repositories and evidence](docs/sources.md)

## License

[MIT](LICENSE), copyright (c) 2026 Kyle Graehl.
