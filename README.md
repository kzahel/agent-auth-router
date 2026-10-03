# Agent Auth Router

A proposed small, private gateway for Claude Code and Codex subscription
accounts. Clients authenticate to the router with revocable gateway tokens;
the router selects an account and authenticates upstream with that account's
current provider credential.

**Status: early prototype.** A headless Node/TypeScript slice is tested against
synthetic credentials, fake helpers and mock upstreams. An authorized real
Codex client and a real Claude Code client each completed one streamed
interaction through the router using gateway tokens. Claude's dedicated
macOS Keychain entry is read through an explicit enrollment mode. Durable
renewal remains unverified for both providers. See
[prototype status](docs/prototype.md).

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

The implementation direction is Node.js with TypeScript, headless first, with
a small embedded HTML/CSS/JavaScript dashboard. A desktop tray application can
later supervise the same service and adopt Desktop Release Kit's packaging
and signed-update contracts.

## Approach to try

Use the official provider CLIs as the owners of OAuth login, storage and
refresh. Give each upstream account a dedicated `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`. An Add account action opens a terminal for the official
CLI's login. A serialized helper invocation later lets that CLI renew its
credentials; the router rereads the authoritative store after renewal.

This is a hypothesis to validate, especially for Claude. Merely starting a
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

## Read next

- [Prototype status, observations and next experiment](docs/prototype.md)
- [Architecture and security boundaries](docs/architecture.md)
- [Credential lifecycle and refresh experiment](docs/auth-lifecycle.md)
- [Implementation and validation plan](docs/plan.md)
- [Source repositories and evidence](docs/sources.md)

Initial focus is a local macOS host. Private access from other devices and
cross-platform packaging are later extensions. This project stays separate
from Yep Anywhere's CLI profile-directory work.
