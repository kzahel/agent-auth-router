# Source repositories and evidence

Initial research: 2026-10-02; follow-up inspections recorded through 2026-10-04.
Repository revisions below identify the local source
snapshots inspected during the discussion. They are research references, not
runtime dependencies. Recheck the deployed CLI versions before implementation.

## CLIProxyAPI and VibeProxy

| Repository | Inspected revision | Relevance |
| --- | --- | --- |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `6fecc6e5567912661654a4eaf9b8f5436facd1c2` | Provider protocols, OAuth ownership, routing, administration and risk surface |
| [automazeio/vibeproxy](https://github.com/automazeio/vibeproxy) | `1405d044ba9476083885c98e477ad6c3f40e203d` | macOS wrapper, bundled backend, request-rewriting listener, signing and Sparkle updates |

CLIProxyAPI implements its own OAuth browser flows, credential storage and
refresh. This project's intended distinction is delegated official-CLI refresh
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

A later route inspection also used CLIProxyAPI revision
`2044a01f422998de79a5da8015141b878886534d`. Neither inspected revision registered
Claude's `/api/hello` warmup path; see the
[versioned probe observations](prototype.md#the-claude-hello-probe). This is
source evidence, not a live compatibility test of CLIProxyAPI.

### Routing-policy follow-up (2026-10-04)

The [routing-policy research](routing-policies.md#reference-implementations)
records a fresh, separate inspection of CLIProxyAPI
`8ef43e4df3b216a42493105d31c2873b69191473` and VibeProxy
`f2aa365523dd739a114fb7bc73a58353c3737c49`, with pinned source links.
CLIProxyAPI exposes round robin, smooth weighted round robin and fill first,
plus optional session affinity; no built-in weekly-reset ranking was found in
the inspected selector/configuration paths. VibeProxy delegates backend routing.
These are source observations, not executed upstream tests or live behavior
verification. The document also specifies proposed AAR Most remaining and
Soonest weekly reset behavior; neither is implemented yet.

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

The initial inspected [openai/codex](https://github.com/openai/codex) revision is
`ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`. Relevant paths:

- [Auth manager: proactive refresh, guarded reload and persistence](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/login/src/auth/manager.rs)
- [CLI login status: loads/reports auth rather than forcing renewal](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/cli/src/login.rs)
- [App-server account/auth operations to investigate](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/app-server/src/request_processors/account_processor.rs)

The source checks access-token expiry near its own renewal window and has a
last-refresh-age fallback. Do not hardcode that policy into this project based
on one snapshot, and do not assume every source method is a supported public
CLI command.

The later refresh trace used revision
`44dd77b71e88c78295736bffd3dc3b684c13be6d`, with the scheduling, locking,
persistence and account-reporting paths linked in
[prototype source observations](prototype.md#source-trace-after-the-experiment).
These source snapshots are not proof that the installed CLI matches either
revision. The installed Codex 0.159.0 schema and live observations are recorded
separately in that document.

Quota interfaces used by the prototype:

- [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
  describes `account/rateLimits/read`; the installed CLI's schema and real
  metadata response were inspected. Multi-bucket/legacy responses, durations
  and epoch-second reset values are normalized in `src/quotas.ts`.
- Claude Code 2.1.280's installed executable contains an internal
  `/api/oauth/usage` GET path and renders its JSON utilization as percentages.
  The authorized metadata read succeeded; this is not a documented public
  endpoint contract. Inference-header utilization is a fraction instead.
  See [quota observations and limits](prototype.md#authorized-quota-reads).
  The router no longer calls this endpoint directly.
- Claude usage now goes through the CLI's control protocol. Yep Anywhere
  `26727241ee2449095b729a369a82e811e47abcad` reads Claude usage with
  `@anthropic-ai/claude-agent-sdk` 0.3.283's
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on a no-prompt
  session (`packages/server/src/sdk/providers/claude.ts`). That SDK starts the
  CLI with `--output-format stream-json --verbose --input-format stream-json`
  and writes `{"type":"control_request","request_id":…,"request":{"subtype":"get_usage"}}`
  after `initialize`. It maps `persistSession: false` to
  `--no-session-persistence`. The router speaks this protocol directly, without
  the SDK. The SDK labels the usage request experimental; it is not a stable
  public contract. See [the probe observations](prototype.md#claude-cli-control-probe).

## Existing desktop and agent projects

| Repository | Inspected revision | Relevance |
| --- | --- | --- |
| [kzahel/desktop-release-kit](https://github.com/kzahel/desktop-release-kit) | `c8d96dd87cb244f96b0123c113b4da17bd698c37` | Tauri sidecar canary, signed packaging, update contracts and installed validation |
| [kzahel/machine-control](https://github.com/kzahel/machine-control) | `2b0d8856091e5b610acea0e19ada182acc3568e1` | Optional desktop operator shell with independent headless runtime |
| [kzahel/lid-awake](https://github.com/kzahel/lid-awake) | `b90bd6a63b3c716c3f24a81c33365ff704bbb6e2` | Small macOS tray application and signed/notarized Sparkle releases |
| [kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) | Initial `4af8b18a194188dda7aa75f02f7cda8d5ac03035`; follow-up `e0105dde50067c2905b4566a339c9c00ee0af08c` | Native launch adapters, gateway services, subscription usage and direct profile-directory proposal |
| [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | `99e08526e5ec84f294940cba5929841518c52fec` | Provider instances, router configuration and built-in CLIProxyAPI usage-source connection; no claim it bundles or owns the hub |

Specific related documents:

- [Desktop Release Kit overview](https://github.com/kzahel/desktop-release-kit/blob/c8d96dd87cb244f96b0123c113b4da17bd698c37/README.md)
- [Desktop update contract](https://github.com/kzahel/desktop-release-kit/blob/c8d96dd87cb244f96b0123c113b4da17bd698c37/contract/desktop-update-v1.md)
- [Machine Control desktop ownership](https://github.com/kzahel/machine-control/blob/2b0d8856091e5b610acea0e19ada182acc3568e1/desktop/README.md)
- [Yep Anywhere profile directories](https://github.com/kzahel/yepanywhere/blob/4af8b18a194188dda7aa75f02f7cda8d5ac03035/docs/tactical/133-provider-profile-directories.md)
- [Yep Anywhere gateway services](https://github.com/kzahel/yepanywhere/blob/4af8b18a194188dda7aa75f02f7cda8d5ac03035/topics/gateway-services.md)
- [YA subscription-usage contract at the follow-up revision](https://github.com/kzahel/yepanywhere/blob/e0105dde50067c2905b4566a339c9c00ee0af08c/topics/provider-subscription-usage.md)
- [T3 provider-instance identities and configuration](https://github.com/pingdotgg/t3code/blob/99e08526e5ec84f294940cba5929841518c52fec/packages/contracts/src/providerInstance.ts)
- [T3 Claude router configuration guidance](https://github.com/pingdotgg/t3code/blob/99e08526e5ec84f294940cba5929841518c52fec/docs/user/providers-claude.md)
- [T3 CLIProxyAPI management/usage adapter](https://github.com/pingdotgg/t3code/blob/99e08526e5ec84f294940cba5929841518c52fec/apps/server/src/usage/cliproxyApi.ts)
- [T3 usage-source scheduling and publishing](https://github.com/pingdotgg/t3code/blob/99e08526e5ec84f294940cba5929841518c52fec/apps/server/src/usage/UsageLimitSources.ts)

The Yep Anywhere proposal chooses a home for an official CLI session and leaves
all credentials with that CLI. This router instead reads provider credentials
to forward model API requests while delegating their renewal. Those are related
but different responsibilities. The agreed, optional integration is now recorded
in YA tactical 143 (`docs/tactical/143-agent-auth-router-integration.md`): it
keeps YA's native client state separate while AAR owns account access,
allocation and quota reads. The direct profile path remains independent. See
[the integration direction](plan.md#yep-anywhere-integration); the control API
and YA integration are not implemented.

The conversation began with [Theo's video](https://www.youtube.com/watch?v=D8PikZ1KhUo).
The exact custom fork discussed in that video was not identified, so no claims
about its source or security are part of this plan. The earlier reference to a
local `lid-control` project corresponded to the inspected `lid-awake` checkout.
