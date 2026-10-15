# Local reference checkouts

Source checkouts of related projects, for reading and comparison. They are
research references, not runtime dependencies. Checkout contents are
gitignored; this README and `pins.toml` are tracked.

```bash
python3 scripts/references.py sync       # clone or move checkouts to their pins
python3 scripts/references.py status     # read-only validation
python3 scripts/references.py upstream   # how far each pin trails upstream
python3 scripts/references.py sync --only pi
```

The script needs Python 3.11 or newer and only the standard library. `sync`
clones missing checkouts as blobless clones and checks out each exact pinned
revision, detached. It refuses to touch checkouts with local changes or an
unexpected origin. `upstream` may fetch objects but never moves a pin.

## Pins and when to move them

Pins are exact commits so that source links in the docs keep pointing at what
was read. Before relying on a reference for a design decision, run `upstream`.
If the pin trails by more than a few commits in the area you are reading, read
the newer revision: bump `revision` in `pins.toml`, run `sync`, and update the
table below and any doc that cites the old revision (mainly
[docs/sources.md](../docs/sources.md)). A doc may keep citing an older
revision on purpose when it records what was inspected at the time.

| Name | Pinned revision | Role |
| --- | --- | --- |
| `cliproxyapi` | `8ef43e4df3b216a42493105d31c2873b69191473` (inspected 2026-10-04) | Provider protocols, OAuth ownership, routing policies, token counting. MIT. |
| `vibeproxy` | `f2aa365523dd739a114fb7bc73a58353c3737c49` (inspected 2026-10-04) | macOS wrapper around CLIProxyAPI: bundling, request rewriting, signing, Sparkle updates. Optional. |
| `genai-prices` | `a7e6d36cb10bd4829d3773d37ede7a3daebaa00d` (2026-10-14) | Source of the vendored API price table in `src/prices-data.ts`; see [docs/pricing.md](../docs/pricing.md). MIT. |
| `pi` | `dc939913f6142adce7c09da5707fdd6451b37fb0` (2026-10-15) | pi coding agent (earendil-works/pi, formerly badlogic/pi-mono): provider clients, model registry and per-model API prices. |

Reading a project's source is not a claim that its behavior is stable or
officially supported for this router. Before adapting code or data, record its
origin and license next to the reused material, as for any source reuse.

## First-party siblings

[Yep Anywhere](https://github.com/kzahel/yepanywhere) is usually checked out
at `../yepanywhere` and holds the integration plan (tactical 143). It is not
managed here: it is an active working repository, and syncing it from this
repository could disturb work in progress there.
