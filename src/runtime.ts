import { recoverDesktopSocket } from "./desktop-lifecycle.ts";
import type { QuotaReadOptions } from "./quotas.ts";
import { startControl } from "./control.ts";
import { startDashboard, type Dashboard } from "./dashboard.ts";
import { EventLog, eventLogEnabled } from "./events.ts";
import { Metrics } from "./metrics.ts";
import { join } from "node:path";
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
  dashboard?: Dashboard;
  metrics: Metrics;
  /** Present when the analysis event log is enabled. */
  events?: EventLog;
  close(force?: boolean): Promise<void>;
}

export interface DashboardOptions { port: number; uiDir?: string; dev?: boolean }

export async function startRouter(store: StateStore, quotaOptions: QuotaReadOptions = {}, lifecycle: { desktop?: boolean; recoverStaleSocket?: boolean; cancelProcesses?: () => Promise<void>; onClosed?: () => void; dashboard?: DashboardOptions; eventLog?: boolean } = {}): Promise<RunningRouter> {
  store.init();
  const metrics = new Metrics({ path: join(store.dir, "metrics.json") });
  // Default on; AAR_EVENT_LOG=0 or --no-event-log switches it off.
  const events = (lifecycle.eventLog ?? eventLogEnabled()) ? new EventLog({ dir: join(store.dir, "events") }) : undefined;
  if (events) metrics.onEvent(({ entry }) => { if (entry.outcome !== "active") { const { id: _id, ...rest } = entry; events.write("request", rest); } });
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
      await dashboard?.close();
      await control?.close();
      await stopped;
      await cancelling;
      metrics.close();
      events?.write("router", { action: "stop", routerId: control?.registry.routerId ?? null, pid: process.pid });
      events?.close();
      lifecycle.onClosed?.();
    })();
  };
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let dashboard: Dashboard | undefined;
  const router = createRouter({ config, clients: () => [...clients.current(), ...(control?.registry.clients() ?? [])], coordinators, observer: metrics,
    describeClient: client => control?.registry.describeClient(client) ?? { name: client.name }, onProviderResponse: (accountId, status, retryAfter, headers, requestId) => {
    if (!control) return;
    const provider = coordinators.get(accountId)?.account.provider;
    control.evidence.reject(accountId, status, retryAfter);
    if ([401, 403, 429].includes(status)) events?.write("rejection", { accountId, provider: provider ?? null, status, retryAfter: retryAfter ?? null, requestId: requestId ?? null });
    // Every successful proxied turn is quota evidence; rejections keep their cooldown path.
    if (provider && headers && status >= 200 && status < 300) control.evidence.observe(accountId, provider, headers, Date.now(), requestId);
  } });

  await new Promise<void>((resolve, reject) => {
    router.server.once("error", reject);
    router.server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const address = router.server.address() as AddressInfo;
  const boundOrigin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  if (process.platform !== "win32") {
    try {
      // A router killed before cleanup leaves a refusing socket; long-running
      // serve modes set it aside after verifying nothing answers on it.
      if (lifecycle.desktop || lifecycle.recoverStaleSocket) await recoverDesktopSocket(store);
      control = await startControl(store, boundOrigin, coordinators, quotaOptions, {
        active: router.activeRequests,
        stop: (force) => { router.server.close(); setImmediate(() => { void close(force); }); },
      }, metrics, events);
      events?.write("router", { action: "start", routerId: control.registry.routerId, pid: process.pid, accounts: coordinators.size });
      if (lifecycle.dashboard) {
        const owner = control.owner;
        dashboard = await startDashboard({ store, hub: control.hub, authenticateOwner: header => owner.authenticate(header), port: lifecycle.dashboard.port, ...(lifecycle.dashboard.uiDir ? { uiDir: lifecycle.dashboard.uiDir } : {}), dev: lifecycle.dashboard.dev === true });
        owner.extensions.dashboard = dashboard;
      }
    }
    catch (error) { router.server.close(); await control?.close(); metrics.close(); events?.close(); throw error; }
  }
  log("router.listening", { origin: boundOrigin, accounts: coordinators.size });

  return {
    ...router,
    origin: boundOrigin,
    coordinators,
    ...(control ? { controlSocket: control.socketPath } : {}),
    ...(dashboard ? { dashboard } : {}),
    metrics,
    ...(events ? { events } : {}),
    close,
  };
}
