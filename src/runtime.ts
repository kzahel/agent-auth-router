import { recoverDesktopSocket } from "./desktop-lifecycle.ts";
import type { QuotaReadOptions } from "./quotas.ts";
import { startControl } from "./control.ts";
import { startDashboard, type Dashboard } from "./dashboard.ts";
import { parsePublicOrigin, startPublic, type PublicListener } from "./public.ts";
import { EventLog, eventLogEnabled } from "./events.ts";
import { HistoryStore } from "./history.ts";
import { Metrics } from "./metrics.ts";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CredentialCoordinator } from "./coordinator.ts";
import { credentialReaderFor } from "./credentials.ts";
import { accountHelper } from "./helpers.ts";
import { errorText, log } from "./log.ts";
import type { OwnerLifecycle } from "./owner.ts";
import { createRouter, type RouterServer } from "./server.ts";
import { LiveClients, type StateStore } from "./state.ts";
import type { AccountConfig, Provider } from "./types.ts";

export function buildCoordinators(
  accounts: readonly AccountConfig[],
  workDir: string,
  routerOrigin: string | undefined,
  providerEnabled: (provider: Provider) => boolean = () => true,
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
        enabled: () => providerEnabled(account.provider),
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
  /** The opt-in listener a TLS reverse proxy exposes at a public origin. */
  public?: PublicListener;
  metrics: Metrics;
  /** Present when the analysis event log is enabled. */
  events?: EventLog;
  close(force?: boolean): Promise<void>;
}

export interface DashboardOptions { port: number; uiDir?: string; dev?: boolean; publicReadonly?: boolean }
/** `origin` is the https origin the proxy serves; `port` is the loopback port it forwards to. */
export interface PublicOptions { origin: string; port: number }

export async function startRouter(store: StateStore, quotaOptions: QuotaReadOptions = {}, lifecycle: { desktop?: boolean; recoverStaleSocket?: boolean; cancelProcesses?: () => Promise<void>; onClosed?: () => void; dashboard?: DashboardOptions; public?: PublicOptions; eventLog?: boolean; restart?: OwnerLifecycle["restart"] } = {}): Promise<RunningRouter> {
  const publicOrigin = lifecycle.public ? parsePublicOrigin(lifecycle.public.origin).origin : undefined;
  if (lifecycle.public && process.platform === "win32") throw new Error("the public listener needs the control socket, which Windows does not support yet");
  store.init();
  // History is best effort: without it the router still routes and charts live traffic.
  let history: HistoryStore | undefined;
  try { history = new HistoryStore(join(store.dir, "history.db")); } catch (error) { log("history.open_failed", { error: errorText(error) }); }
  // Default on; AAR_EVENT_LOG=0 or --no-event-log switches it off. It shares the history retention.
  const events = (lifecycle.eventLog ?? eventLogEnabled()) ? new EventLog({ dir: join(store.dir, "events"), ...(history ? { retentionDays: history.retentionDays() } : {}) }) : undefined;
  const metrics = new Metrics(history ? { history } : {});
  metrics.onPrune = days => events?.prune(days);
  if (events) metrics.onEvent(({ entry }) => { if (entry.outcome !== "active") { const { id: _id, ...rest } = entry; events.write("request", rest); } });
  const config = store.loadConfig();
  const origin = `http://${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${config.listen.port}`;
  const coordinators = buildCoordinators(store.loadAccounts(), store.workDir, origin, provider => store.providerEnabled(provider));
  const clients = new LiveClients(store);
  let closing: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  const close = (force = false): Promise<void> => {
    if (force) {
      router.server.closeAllConnections();
      publicListener?.server.closeAllConnections();
      cancelling ??= lifecycle.cancelProcesses?.() ?? Promise.resolve();
    }
    return closing ??= (async () => {
      // Stop admission synchronously before waiting for accepted streams.
      const stopped = new Promise<void>(resolve => { router.server.close(() => resolve()); router.server.closeIdleConnections(); });
      const publicStopped = publicListener?.close();
      await dashboard?.close();
      await control?.close();
      await stopped;
      await publicStopped;
      await cancelling;
      metrics.close();
      history?.close();
      events?.write("router", { action: "stop", routerId: control?.registry.routerId ?? null, pid: process.pid });
      events?.close();
      lifecycle.onClosed?.();
    })();
  };
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let dashboard: Dashboard | undefined;
  let publicListener: PublicListener | undefined;
  const router = createRouter({ config, clients: () => [...clients.current(), ...(control?.registry.clients() ?? [])], coordinators, observer: metrics,
    requestCompression: provider => provider === "antigravity" ? "off" : store.loadSettings().requestCompression[provider] ?? "off",
    providerEnabled: provider => store.providerEnabled(provider),
    describeClient: client => control?.registry.describeClient(client) ?? { name: client.name },
    onCyberAccessResponse: (observation) => events?.write("cyber-access", observation),
    sessionAccount: ({ client, provider, poolId, sessionId, model }) => control
      ? control.registry.sessionAccount(client, provider, poolId, sessionId, model, control.evidence)
      : Promise.reject(Object.assign(new Error("gateway pools need the control socket"), { status: 503 })),
    onProviderResponse: (accountId, status, retryAfter, headers, requestId) => {
    if (!control) return;
    const provider = coordinators.get(accountId)?.account.provider;
    // A reply to a request sent before the provider was turned off starts no cooldown for when it is back on.
    if (provider && !store.providerEnabled(provider)) return;
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
        ...(lifecycle.restart ? { restart: lifecycle.restart } : {}),
      }, metrics, events);
      events?.write("router", { action: "start", routerId: control.registry.routerId, pid: process.pid, accounts: coordinators.size });
      if (lifecycle.dashboard) {
        const owner = control.owner;
        dashboard = await startDashboard({ store, hub: control.hub, authenticateOwner: header => owner.authenticate(header), port: lifecycle.dashboard.port, ...(lifecycle.dashboard.uiDir ? { uiDir: lifecycle.dashboard.uiDir } : {}), dev: lifecycle.dashboard.dev === true, publicReadonly: lifecycle.dashboard.publicReadonly === true, ...(publicOrigin ? { publicOrigin } : {}) });
        owner.extensions.dashboard = dashboard;
      }
      if (lifecycle.public && publicOrigin) {
        publicListener = await startPublic({ origin: publicOrigin, port: lifecycle.public.port, maxHeaderBytes: router.limits.maxHeaderBytes, requestTimeoutMs: router.limits.clientRequestTimeoutMs,
          surfaces: { inference: router.handleRequest, control: control.publicHandler(publicOrigin), ...(dashboard?.public ? { dashboard: dashboard.public } : {}) } });
        control.owner.extensions.publicOrigin = publicOrigin;
        log("public.listening", { origin: publicOrigin, port: publicListener.port });
      }
    }
    catch (error) { router.server.close(); await dashboard?.close(); await control?.close(); metrics.close(); history?.close(); events?.close(); throw error; }
  }
  log("router.listening", { origin: boundOrigin, accounts: coordinators.size });

  return {
    ...router,
    origin: boundOrigin,
    coordinators,
    ...(control ? { controlSocket: control.socketPath } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(publicListener ? { public: publicListener } : {}),
    metrics,
    ...(events ? { events } : {}),
    close,
  };
}
