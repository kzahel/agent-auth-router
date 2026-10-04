# Repository instructions

This repository contains an early headless Node/TypeScript prototype, synthetic
tests and limited authorized live observations. Read README.md,
docs/prototype.md and the relevant docs before changing its direction. Keep
implemented behavior, proposals, source observations and verified product
behavior distinct; successful proxy requests do not prove credential renewal.

The cross-repository integration plan is Yep Anywhere tactical 143,
`docs/tactical/143-agent-auth-router-integration.md` in the Yep Anywhere
repository. Read it before implementing control/pairing, account pools,
balancing or YA integration. Those features are planned, not implemented here.

- Keep the core headless and independent of any desktop shell.
- Prefer a small Node.js/TypeScript implementation and narrow dependencies.
- Official CLI ownership of OAuth is the approach to test. Do not silently
  replace it with router-owned token exchange, refresh or credential copying.
- Do not read real credentials or invoke paid inference to validate a claim
  unless the task authorizes that operation. Use synthetic fixtures first.
- Never commit credentials, profile homes, logs containing secrets, signing
  keys, machine-local configuration or private infrastructure inventory.
- Before commits or pushes, inspect the exact staged files and diff.
- Use the maintainer's Git identity. Record model involvement only with a
  `Contributing-model: <short-model-name>` trailer, one per contributing model.
- Match checks to the change. Documentation changes need link/content review;
  executable changes need tests covering their actual security and lifecycle
  boundaries. Report verification and remaining uncertainty accurately.

Source reuse must preserve applicable license notices. References to upstream
code are not a claim that upstream behavior is stable or officially supported
for this router.
