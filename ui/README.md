# Management UI

The UI shared by the desktop window and the web dashboard (`aar serve`):
TypeScript built with Vite. It talks to the router only through the app
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

- `index.html`, `src/main.ts`: the management page.
- `terminal.html`, `src/terminal/`: the desktop's sign-in terminal window
  (xterm). The web dashboard does not serve it.
- `src/protocol/`: the protocol client, its desktop and browser ports, and
  payload types written from the core's operations.
- `src/dashboard.ts`, `src/chart/`: the Dashboard tab and its canvas charts.
- `src/lib/`: formatting and quota helpers.
- `src/styles/global.css`: theme variables and element styles.

The build's `.vite/manifest.json` tells the web dashboard which files the
management page needs. `third-party-licenses.txt` carries the license
notices of bundled packages.
