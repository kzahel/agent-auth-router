import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppClient, DesktopShell, WebShell } from "../protocol/client.ts";
import type { RouterState, RouterView } from "./router-state.ts";

export interface App {
  client: AppClient;
  router: RouterState;
  /** Desktop-only features; undefined in the web dashboard. */
  native: DesktopShell | undefined;
  /** Web-only features; undefined in the desktop app. */
  web: WebShell | undefined;
  /** Typed shorthand for `client.call`. */
  api<T = Record<string, unknown>>(operation: string, body?: object): Promise<T>;
}

const AppContext = createContext<App | undefined>(undefined);

export function AppProvider({ client, router, children }: { client: AppClient; router: RouterState; children: ReactNode }) {
  const shell = client.shell;
  const value: App = {
    client, router,
    native: shell.native ? shell : undefined,
    web: shell.native ? undefined : shell,
    api: (operation, body = {}) => client.call(operation, body),
  };
  return <AppContext value={value}>{children}</AppContext>;
}

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp outside AppProvider");
  return app;
}

/** The router's overview, status and error line, re-rendering on change. */
export function useRouterView(): RouterView {
  const { router } = useApp();
  return useSyncExternalStore(router.subscribe, () => router.view);
}
