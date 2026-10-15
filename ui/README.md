# Management UI

The UI shared by the desktop window and the web dashboard (`aar serve`):
React and TypeScript with CSS Modules, built with Vite. It talks to the router only through the app
protocol in `src/protocol/client.ts`; see [the dashboard design](../docs/dashboard.md).

```sh
npm ci              # from this directory, or `npm ci --prefix ui` from the root
npm run build       # writes dist/, which the router and the desktop app serve
npm run check       # typecheck, unit tests (Vitest) and build
```

From the repository root, `npm run dev` rebuilds on change and runs
`aar serve --dev`, which reloads signed-in browsers after each rebuild. The
browser regression tests in `desktop/test` run against `dist/`.

## Layout

- `index.html`, `src/main.tsx`: the management page.
- `src/app/`: the shell (status banner, tabs, error line, confirmation
  dialog) and `RouterState`, which holds the latest overview and coalesces
  the router's change events into overview requests.
- `src/accounts/`, `src/pools/`, `src/connections/`, `src/settings/`,
  `src/dashboard/`: one folder per tab.
- `src/components/`: small shared components.
- `src/protocol/`: the protocol client, its desktop and browser ports, and
  payload types written from the core's operations.
- `src/chart/`: the canvas traffic graph and sparklines.
- `src/lib/`: formatting, quota and account-label helpers.
- `src/styles/global.css`: theme variables and element defaults;
  `ui.module.css`: pieces several components share. Other styles are CSS
  Modules beside their components.
- `terminal.html`, `src/terminal/`: the desktop's sign-in terminal window
  (xterm). The web dashboard does not serve it.
- `src/test/`: test setup and `fakeApp`, a router behind a fake port for
  component tests.

## State

There is no state library. The router pushes what changes: `RouterState`
fetches the overview again on each change event and components read it with
`useRouterView`; the Dashboard subscribes to `live`, `history`, `activity`
and `requests` while it is shown. Editors keep what is typed in their own
state, so router updates never disturb them.

The build's `.vite/manifest.json` tells the web dashboard which files the
management page needs. `third-party-licenses.txt` carries the license
notices of bundled packages.
