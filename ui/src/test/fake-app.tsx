// A router behind a fake port for component tests: calls are answered by
// handlers, recorded, and failures become protocol errors.

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConfirmProvider } from "../app/ConfirmDialog.tsx";
import { AppProvider } from "../app/context.tsx";
import { RouterState } from "../app/router-state.ts";
import { AppClient, type DesktopShell, type Inbound, type Port } from "../protocol/client.ts";
import type { Account, Overview } from "../protocol/types.ts";

type Handler = (body: Record<string, unknown>) => unknown;

export function account(id: string, change: Partial<Account> = {}): Account {
  return { id, home: `/profiles/${id}`, nickname: null, provider: "codex", enabled: true, revision: 1, freshness: "fresh", windows: [], ...change };
}

export function overview(change: Partial<Overview> = {}): Overview {
  return { routerId: "fixture", activeRequests: 0, accounts: [], pools: [], integrations: [], logins: [], ...change };
}

export async function fakeApp(handlers: Record<string, Handler> = {}, options: { native?: Partial<DesktopShell> } = {}) {
  const calls: { operation: string; body: Record<string, unknown> }[] = [];
  let deliver: (message: Inbound) => void = () => {};
  const port: Port = {
    kind: options.native ? "desktop" : "web",
    connect: async () => ({ protocol: 1, routerId: "fixture", kind: options.native ? "desktop" : "web" }),
    send: (message) => {
      if (!("call" in message)) return;
      const body = message.body as Record<string, unknown>;
      calls.push({ operation: message.call, body });
      const handler = handlers[message.call] ?? (message.call === "overview" ? () => overview() : () => ({}));
      void (async () => {
        try { deliver({ id: message.id, result: await handler(body) }); }
        catch (failure) { deliver({ id: message.id, error: { status: 409, message: (failure as Error).message } }); }
      })();
    },
    onMessage: (handler) => { deliver = handler; },
    onClose: () => {},
    shell: options.native
      ? { native: true, terminalLogin: async () => ({}), startup: async () => false, openProject: async () => ({}), checkUpdate: async () => ({}), installUpdate: async () => ({}), onLifecycleError: async () => ({}), ...options.native }
      : { native: false, logout: async () => ({}) },
  };
  const client = new AppClient(port);
  const router = new RouterState(client, !!options.native);
  await client.start();
  return {
    client, router, calls,
    /** The calls made for one operation, in order. */
    called: (operation: string) => calls.filter(c => c.operation === operation),
    render: (ui: ReactNode) => render(<AppProvider client={client} router={router}><ConfirmProvider>{ui}</ConfirmProvider></AppProvider>),
  };
}
