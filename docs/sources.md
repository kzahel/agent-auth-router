# Source repositories and evidence

Research date: 2026-10-02. Repository revisions below identify the local source
snapshots inspected during the discussion. They are research references, not
runtime dependencies. Recheck the deployed CLI versions before implementation.

## CLIProxyAPI and VibeProxy

| Repository | Inspected revision | Relevance |
| --- | --- | --- |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `6fecc6e5567912661654a4eaf9b8f5436facd1c2` | Provider protocols, OAuth ownership, routing, administration and risk surface |
| [automazeio/vibeproxy](https://github.com/automazeio/vibeproxy) | `1405d044ba9476083885c98e477ad6c3f40e203d` | macOS wrapper, bundled backend, request-rewriting listener, signing and Sparkle updates |

CLIProxyAPI implements its own OAuth browser flows, credential storage and
refresh. This project's proposed distinction is delegated official-CLI refresh
and a much smaller provider/control surface. Useful pinned reference paths:

- [Claude browser login](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/sdk/auth/claude.go)
- [Codex browser login](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/sdk/auth/codex.go)
- [Claude OAuth exchange and refresh](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/auth/claude/anthropic_auth.go)
- [Codex OAuth exchange and refresh](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/auth/codex/openai_auth.go)
- [Credential refresh coordination](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/sdk/cliproxy/auth/conductor_refresh.go)
- [Client authentication](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/access/config_access/provider.go)
- [Management authentication](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/api/handlers/management/handler.go)
- [Claude native and fallback token counting](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/runtime/executor/claude_executor_tokens.go)
- [Cross-protocol input-token estimates](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/internal/runtime/executor/helps/claude_input_tokens.go)
- [Dependency graph](https://github.com/router-for-me/CLIProxyAPI/blob/6fecc6e5567912661654a4eaf9b8f5436facd1c2/go.mod)
- [VibeProxy additional Swift HTTP listener](https://github.com/automazeio/vibeproxy/blob/1405d044ba9476083885c98e477ad6c3f40e203d/src/Sources/ThinkingProxy.swift)
- [VibeProxy release workflow](https://github.com/automazeio/vibeproxy/blob/1405d044ba9476083885c98e477ad6c3f40e203d/.github/workflows/release.yml)

CLIProxyAPI is MIT-licensed. If code is adapted, preserve the required notices
and document what was reused. Disabling its features through configuration
does not remove the implementation or dependency surface from a bundled build.

## Official CLI authentication

- [Codex authentication and credential storage](https://developers.openai.com/codex/auth)
  documents automatic renewal during use and file/OS-store modes.
- [Maintain Codex account auth in private CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
  documents running the official CLI and retaining the credential state it
  refreshes. Its recommendation for general automation is API keys. It is
  evidence for delegated renewal, not an endorsement of this gateway design.
- [Codex with externally supplied OAuth tokens](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
  describes renewal responsibility when the host supplies access tokens.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
  documents isolated account configuration directories and credential behavior.
- [Reported Claude short-lived-command persistence issue](https://github.com/anthropics/claude-code/issues/95822)
  motivates verifying completed persistence. The report was read, not reproduced.

The inspected [openai/codex](https://github.com/openai/codex) revision is
`ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`. Relevant paths:

- [Auth manager: proactive refresh, guarded reload and persistence](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/login/src/auth/manager.rs)
- [CLI login status: loads/reports auth rather than forcing renewal](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/cli/src/login.rs)
- [App-server account/auth operations to investigate](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/app-server/src/request_processors/account_processor.rs)

The source checks access-token expiry near its own renewal window and has a
last-refresh-age fallback. Do not hardcode that policy into this project based
on one snapshot, and do not assume every source method is a supported public
CLI command.

## Existing desktop and agent projects

| Repository | Inspected revision | Relevance |
| --- | --- | --- |
| [kzahel/desktop-release-kit](https://github.com/kzahel/desktop-release-kit) | `c8d96dd87cb244f96b0123c113b4da17bd698c37` | Tauri sidecar canary, signed packaging, update contracts and installed validation |
| [kzahel/machine-control](https://github.com/kzahel/machine-control) | `2b0d8856091e5b610acea0e19ada182acc3568e1` | Optional desktop operator shell with independent headless runtime |
| [kzahel/lid-awake](https://github.com/kzahel/lid-awake) | `b90bd6a63b3c716c3f24a81c33365ff704bbb6e2` | Small macOS tray application and signed/notarized Sparkle releases |
| [kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) | `4af8b18a194188dda7aa75f02f7cda8d5ac03035` | Existing TypeScript provider experience and separate profile-directory proposal |
| [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | Not pinned in this document | Client-side provider configuration reference; no claim it bundles CLIProxyAPI |

Specific related documents:

- [Desktop Release Kit overview](https://github.com/kzahel/desktop-release-kit/blob/c8d96dd87cb244f96b0123c113b4da17bd698c37/README.md)
- [Desktop update contract](https://github.com/kzahel/desktop-release-kit/blob/c8d96dd87cb244f96b0123c113b4da17bd698c37/contract/desktop-update-v1.md)
- [Machine Control desktop ownership](https://github.com/kzahel/machine-control/blob/2b0d8856091e5b610acea0e19ada182acc3568e1/desktop/README.md)
- [Yep Anywhere profile directories](https://github.com/kzahel/yepanywhere/blob/4af8b18a194188dda7aa75f02f7cda8d5ac03035/docs/tactical/133-provider-profile-directories.md)
- [Yep Anywhere gateway services](https://github.com/kzahel/yepanywhere/blob/4af8b18a194188dda7aa75f02f7cda8d5ac03035/topics/gateway-services.md)

The Yep Anywhere proposal chooses a home for an official CLI session and leaves
all credentials with that CLI. This router instead reads provider credentials
to forward model API requests while delegating their renewal. Those are related
but different responsibilities; this repository does not change YA's plan.

The conversation began with [Theo's video](https://www.youtube.com/watch?v=D8PikZ1KhUo).
The exact custom fork discussed in that video was not identified, so no claims
about its source or security are part of this plan. The earlier reference to a
local `lid-control` project corresponded to the inspected `lid-awake` checkout.
