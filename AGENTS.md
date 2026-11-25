# Repository instructions

## Product scope

AAR makes metered Claude and ChatGPT subscription accounts easier to use
across machines. Its core features are quota and reset visibility, account
pools, session pinning and access grants. Keep upstream enrollment and routing
focused on subscription logins. Provider API-key accounts, pay-as-you-go API
routing and further Antigravity integration are outside the current scope.
AAR-issued gateway tokens authorize clients to use the router.

## Development

Read [README.md](README.md), [docs/prototype.md](docs/prototype.md) and the
relevant topic docs before changing direction. Keep implemented behavior,
proposals, source observations and verified product behavior distinct.
Successful proxy requests do not prove credential renewal.

For control, pairing, account pools, balancing or YA integration, read
[docs/control.md](docs/control.md), [docs/pools.md](docs/pools.md) and the
cross-repository design in Yep Anywhere's
`docs/tactical/143-agent-auth-router-integration.md`.

- Keep the core headless and independent of any desktop shell.
- Prefer a small Node.js/TypeScript implementation and narrow dependencies.
  The management UI in `ui/` is the deliberate exception: React, Vite and
  their test tools, bundled into a static build that the core serves. The
  core itself keeps no runtime dependencies.
- Official CLI ownership of OAuth is the approach to test. Do not silently
  replace it with router-owned token exchange, refresh or credential copying.
- Do not read real credentials or invoke paid inference to validate a claim
  unless the task authorizes that operation. Use synthetic fixtures first.
- Never commit credentials, profile homes, logs containing secrets, signing
  keys, machine-local configuration or private infrastructure inventory.
- To load code changes into a running `aar serve`, use `aar restart` (once
  idle) or `aar restart --now` (cuts off open requests, waits for the new
  router to answer). Never stop the serve process or its tmux session for
  this: agent sessions, possibly your own, may route inference through it.
- Before commits or pushes, inspect the exact staged files and diff.
- Use the maintainer's Git identity. Record model involvement only with a
  `Contributing-model: <short-model-name>` trailer, one per contributing model.
- Match checks to the change. Documentation changes need link/content review;
  executable changes need tests covering their actual security and lifecycle
  boundaries. Report verification and remaining uncertainty accurately.

Related projects (CLIProxyAPI, VibeProxy, pi) can be checked out locally with
`python3 scripts/references.py sync`; see [reference/README.md](reference/README.md).
Before relying on one, run `python3 scripts/references.py upstream` and, if
the pin trails in the area you are reading, consider moving it as that README
describes.

Cost estimates at API rates are described in [docs/pricing.md](docs/pricing.md);
to audit or tighten them, start with its "Auditing estimates" section.

Source reuse must preserve applicable license notices. References to upstream
code are not a claim that upstream behavior is stable or officially supported
for this router.
