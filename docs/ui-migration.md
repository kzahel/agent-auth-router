# UI migration: Vite, TypeScript, React and CSS Modules

Status: done (2026-10-15). The outcome and the places it differs from the
plan are at the end.

The management UI (desktop window and web dashboard) was about 2,300 lines
of unbundled browser JavaScript in `desktop/ui`: imperative DOM rendering,
module-level state, one global stylesheet and no unit tests. This plan moves
it to TypeScript with a build step, then to React with CSS Modules, without
changing the protocol, the security model or what the user sees.

## Decisions

- **Package:** a top-level `ui/` package with its own `package.json` and
  lockfile, like `desktop/`. The UI is shared by the desktop shell and the web
  dashboard, so it does not belong under `desktop/`. The root package keeps
  no runtime dependencies.
- **Build:** Vite, two entry pages (`index.html` for management,
  `terminal.html` for the desktop sign-in terminal), output to `ui/dist` with
  hashed asset names and a Vite manifest. Relative `base`, so the same output
  works from the Tauri asset protocol and the loopback dashboard.
- **Language:** strict TypeScript, checked with the repository's `tsc`.
  Protocol payload types live in `ui/src/protocol/types.ts`, written from the
  core's payloads. The core's own types import Node modules, so sharing them
  directly would pull the core into the UI's type check; a dependency-free
  protocol module in `src/` would allow that later.
- **Framework:** React. No state library: the protocol pushes updates, so a
  few hooks suffice (`useClient`, `useOverview` refetching on `change` events,
  `useSubscription` for `live`, `history`, `activity` and `requests`).
- **Charts:** the canvas `TrafficGraph` and `sparkline` are kept, typed, and
  wrapped in components through refs.
- **Styles:** CSS Modules per component. Theme variables (`--series-N`,
  `--surface` and so on) and element defaults stay in one global stylesheet.
- **Tests:** Vitest with jsdom and Testing Library for the protocol client,
  formatting and graph helpers, hooks and components. The Playwright tests in
  `desktop/test` remain the end-to-end regression and run against the build.
- **Terminal window:** stays a small imperative TypeScript module; xterm is
  imported from npm and bundled instead of copied into `ui/vendor`.

## Integration changes

- **Serving (`src/dashboard.ts`):** the fixed `ASSETS` list is replaced by the
  Vite manifest: the dashboard serves `index.html` and the files the `index.html`
  entry needs (its chunk, imports and CSS), so terminal-only assets stay
  unserved. Hashed assets may be cached as immutable; `index.html` stays
  `no-store`. The CSP is unchanged.
- **Missing build:** a source checkout without `ui/dist` still runs the router;
  the dashboard answers `/` with 503 and a message naming `npm run build:ui`.
- **Dev loop:** `npm run dev` runs `vite build --watch` beside
  `aar serve --dev`, whose watcher (now recursive over the build) sends
  `ui-reload` when a served file changes. No Vite dev server, so the cookie
  and exact Host/Origin checks are untouched.
- **Desktop:** `tauri.conf.json` `frontendDist` points at `ui/dist`;
  `prepare-bundle.mjs` copies the build into `resources/ui`;
  `prepare-ui.mjs` (xterm vendoring) is replaced by building the UI.
- **Docker:** a build stage produces `ui/dist`; the runtime image copies it.
- **CI:** installs, type-checks, tests and builds `ui/` before the core and
  desktop checks that serve it.
- **Licenses:** the build emits the license texts of bundled packages
  (React, React DOM, scheduler, xterm) as `third-party-licenses.txt`.

## Slices

1. **Build pipeline, typed vanilla TypeScript.** Create `ui/`, port the
   modules to TypeScript with the same DOM code, wire serving, desktop,
   Docker, CI and dev loop, and add Vitest tests for `AppClient` and the
   graph helpers. Behavior unchanged; the Playwright tests pass against
   the build.
2. **React shell and management tabs.** App shell, status banner, tabs,
   confirmation dialog, Accounts, Pools, Connections and Settings in React,
   with the hooks above. The Dashboard keeps its imperative module, mounted
   from a component.
3. **Dashboard in React.** Controls, tiles, legend, graphs, accounts table
   with quota meters and sparklines, requests and sessions.
4. **CSS Modules and tests.** Split the stylesheet into per-component
   modules, add component tests, update `docs/dashboard.md`, `README.md`
   and `AGENTS.md`.

Each slice keeps `npm run check`, the UI checks and the desktop Playwright
tests passing.

## Outcome

- Slice 1 (`3a01b13`), slice 2 (`3ada8fe`) and slice 3 (`436e7d2`) landed
  as planned. CSS Modules arrived with each component rather than in a
  separate slice; slice 4 added the remaining component tests and docs.
- Side-by-side screenshots of the old and new builds (both color schemes,
  both widths the Playwright tests use, every tab and the terminal window)
  match, except for the deliberate changes below.
- Deliberate changes in behavior:
  - An account's More group stays open across router updates and folds
    when one of its actions is chosen; it used to close on every update.
  - A tab that fails to render shows its error instead of blanking the
    window.
  - A remembered pool or account scope survives reloading the page.
  - Chart colors follow a switch between light and dark immediately.
  - A refused History or compression change keeps its reason in view; it
    used to be cleared by the reload that restores the stored value.
- Tests: Vitest covers the protocol client, `RouterState`, formatting,
  graph data handling and each tab's components against `fakeApp`, a
  router behind a fake port. The Playwright tests changed only where they
  relied on the old More behavior or on class names that CSS Modules now
  hash; they find controls by role, id or data attributes.
- Not done: sharing protocol types with the core (see Decisions), and a
  Vite dev server with hot module replacement, which would need the core
  to trust the dev server's origin in `--dev` mode.
