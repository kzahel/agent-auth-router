import type { AddressInfo } from "node:net";
import { CredentialCoordinator } from "./coordinator.ts";
import { credentialReaderFor } from "./credentials.ts";
import { helperFor } from "./helpers.ts";
import { log } from "./log.ts";
import { createRouter, type RouterServer } from "./server.ts";
import { LiveClients, type StateStore } from "./state.ts";
import type { AccountConfig } from "./types.ts";

export function buildCoordinators(
  accounts: readonly AccountConfig[],
  workDir: string,
  routerOrigin: string | undefined,
): Map<string, CredentialCoordinator> {
  const coordinators = new Map<string, CredentialCoordinator>();
  for (const account of accounts) {
    coordinators.set(
      account.id,
      new CredentialCoordinator({
        account,
        read: credentialReaderFor(account.provider, account.home),
        helper: account.helper ? helperFor(account.helper) : undefined,
        helperContext: routerOrigin ? { workDir, routerOrigin } : { workDir },
      }),
    );
  }
  return coordinators;
}

export interface RunningRouter extends RouterServer {
  origin: string;
  coordinators: Map<string, CredentialCoordinator>;
  close(): Promise<void>;
}

export async function startRouter(store: StateStore): Promise<RunningRouter> {
  store.init();
  const config = store.loadConfig();
  const origin = `http://${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${config.listen.port}`;
  const coordinators = buildCoordinators(store.loadAccounts(), store.workDir, origin);
  const clients = new LiveClients(store);
  const router = createRouter({ config, clients: () => clients.current(), coordinators });

  await new Promise<void>((resolve, reject) => {
    router.server.once("error", reject);
    router.server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const address = router.server.address() as AddressInfo;
  const boundOrigin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  log("router.listening", { origin: boundOrigin, accounts: coordinators.size });

  return {
    ...router,
    origin: boundOrigin,
    coordinators,
    close: () =>
      new Promise<void>((resolve) => {
        router.server.close(() => resolve());
        router.server.closeIdleConnections();
      }),
  };
}
