import { recoverDesktopSocket } from "./desktop-lifecycle.ts";
import type { QuotaReadOptions } from "./quotas.ts";
import { startControl } from "./control.ts";
import type { AddressInfo } from "node:net";
import { CredentialCoordinator } from "./coordinator.ts";
import { credentialReaderFor } from "./credentials.ts";
import { accountHelper } from "./helpers.ts";
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
        read: credentialReaderFor(account.provider, account.home, account.credentialStore),
        helper: accountHelper(account),
        helperContext: routerOrigin ? { workDir, routerOrigin } : { workDir },
      }),
    );
  }
  return coordinators;
}

export interface RunningRouter extends RouterServer {
  origin: string;
  coordinators: Map<string, CredentialCoordinator>;
  controlSocket?: string;
  close(force?: boolean): Promise<void>;
}

export async function startRouter(store: StateStore, quotaOptions: QuotaReadOptions = {}, lifecycle: { desktop?: boolean; cancelProcesses?: () => Promise<void>; onClosed?: () => void } = {}): Promise<RunningRouter> {
  store.init();
  const config = store.loadConfig();
  const origin = `http://${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${config.listen.port}`;
  const coordinators = buildCoordinators(store.loadAccounts(), store.workDir, origin);
  const clients = new LiveClients(store);
  let closing: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  const close = (force = false): Promise<void> => {
    if (force) {
      router.server.closeAllConnections();
      cancelling ??= lifecycle.cancelProcesses?.() ?? Promise.resolve();
    }
    return closing ??= (async () => {
      // Stop admission synchronously before waiting for accepted streams.
      const stopped = new Promise<void>(resolve => { router.server.close(() => resolve()); router.server.closeIdleConnections(); });
      await control?.close();
      await stopped;
      await cancelling;
      lifecycle.onClosed?.();
    })();
  };
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  const router = createRouter({ config, clients: () => [...clients.current(), ...(control?.registry.clients() ?? [])], coordinators, onProviderResponse: (accountId, status, retryAfter) => control?.evidence.reject(accountId, status, retryAfter) });

  await new Promise<void>((resolve, reject) => {
    router.server.once("error", reject);
    router.server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const address = router.server.address() as AddressInfo;
  const boundOrigin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  if (process.platform !== "win32") {
    try {
      if (lifecycle.desktop) await recoverDesktopSocket(store);
      control = await startControl(store, boundOrigin, coordinators, quotaOptions, {
        active: router.activeRequests,
        stop: (force) => { router.server.close(); setImmediate(() => { void close(force); }); },
      });
    }
    catch (error) { router.server.close(); throw error; }
  }
  log("router.listening", { origin: boundOrigin, accounts: coordinators.size });

  return {
    ...router,
    origin: boundOrigin,
    coordinators,
    ...(control ? { controlSocket: control.socketPath } : {}),
    close,
  };
}
