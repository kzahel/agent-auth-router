# Agent Auth Router

A small, private gateway prototype for Claude Code and Codex subscription
accounts. Clients authenticate to the router with revocable gateway tokens;
the router selects an account and authenticates upstream with that account's
current provider credential.

**Status: early prototype.** A headless Node/TypeScript slice is tested against
synthetic credentials, fake helpers and mock upstreams. An authorized real
Codex client and a real Claude Code client each completed one streamed
interaction through the router using gateway tokens. Claude's dedicated
macOS Keychain entry is read through an explicit enrollment mode. Durable
renewal remains unverified for both providers. Each gateway credential has one
fixed account assignment per provider; pools and balancing are not implemented.
See [prototype status](docs/prototype.md).

```sh
npm install
npm run check          # typecheck + tests
npm run aar -- --help
```

Fetch current quota percentages and reset times for enrolled accounts:

```sh
npm run aar -- account quotas          # all enrolled accounts
npm run aar -- account quotas <id>     # one enrolled account
```

This on-demand command returns metadata-only JSON and exits with status 2 if
any selected account is unavailable. It requests usage metadata without
inference. Codex uses the official app-server quota RPC; Claude uses the
internal OAuth usage endpoint observed in Claude Code 2.1.280. There is no
background polling or automatic account switching.

The core is Node.js/TypeScript with no runtime dependencies, requiring Node 24
or newer. The recorded live experiments and 65-test check used Node v26.7.0.
Administration currently uses the local CLI. A control socket, dashboard and
desktop tray application are planned; none exists yet.

## Credential ownership and enrollment

Use the official provider CLIs as the owners of OAuth login, storage and
refresh. Give each upstream account a dedicated `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`. `aar account add` enrolls a profile and prints the official
CLI login command for the user to run. It does not open a terminal or sign in.
Serialized helper invocations ask the official CLI to renew; the router rereads
the authoritative store and verifies whether the credential actually changed.

Credential storage defaults to files. On macOS, Claude enrollment needs
`--credential-store claude-keychain` to read only that profile's Keychain entry.
There is no fallback to the user's normal Claude account. Codex enrollment
seeds file storage; that mode was verified for the tested dedicated login.
Claude defaults to the `claude-cli` helper, a no-prompt Claude Code control
session that reads usage and lets the CLI refresh its own credential. An
expired access token with a stored refresh token is therefore idle, not signed
out. See [credential lifecycle](docs/auth-lifecycle.md).

`aar client add <name> --claude <account-id> --codex <account-id>` issues a
gateway credential and prints native-client configuration; grant either or
both providers. Gateway client homes/configuration stay separate from the
upstream account profiles. `aar serve` starts the loopback inference listener.

Reliable delegated renewal is still a hypothesis to validate. Merely starting a
process or observing a successful exit does not prove that credentials were
renewed and persisted. If a reliable helper invocation cannot be established,
surface that limitation before choosing a different credential architecture.

```text
Claude / Codex clients -- gateway credentials --> Node router
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

Gateway client configuration and upstream account homes are separate. Refresh
helpers reach the real provider, without inheriting the router's base URL or
gateway credentials. The router does not run a full CLI agent to fulfill each
model request.

## Yep Anywhere integration

The agreed integration direction is local HTTP over an owner-only Unix control
socket, scoped pairing credentials, account pools and balancing, and durable
per-session account bindings. YA's server connects to the router; its browser
and phone clients keep using their existing YA connection. Coding processes
receive separate inference credentials. These control and allocation features
are not implemented.

The canonical plan covering both repositories is tactical 143,
`docs/tactical/143-agent-auth-router-integration.md`, in the
[Yep Anywhere repository](https://github.com/kzahel/yepanywhere). YA's direct
CLI profile-directory work remains a separate proposal.

## Read next

- [Prototype status, observations and next experiment](docs/prototype.md)
- [Architecture and security boundaries](docs/architecture.md)
- [Credential lifecycle and refresh experiment](docs/auth-lifecycle.md)
- [Implementation and validation plan](docs/plan.md)
- [Source repositories and evidence](docs/sources.md)

Initial focus is a local macOS host. Remote router control, Windows transport
parity and cross-platform packaging are later extensions.

## License

[MIT](LICENSE), copyright (c) 2026 Kyle Graehl.
