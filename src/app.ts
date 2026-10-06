// UI message protocol shared by the desktop shell and the web dashboard.
// Calls reuse owner operations; subscriptions push metadata-only events.
// The desktop pipe is newline-delimited JSON over a private Unix socket;
// the web pipe is a loopback WebSocket. Neither is served on the inference
// listener, and the core decides which operations each pipe may call.

import { existsSync, lstatSync, chmodSync, unlinkSync } from "node:fs";
import net from "node:net";
import { ControlError } from "./control.ts";
import { errorText, log } from "./log.ts";
import { COUNTERS, isMetric, isRange, isScope, RANGES, type Metrics, type RangeName } from "./metrics.ts";
import type { OwnerService } from "./owner.ts";

export const APP_PROTOCOL = 1;
export type AppKind = "desktop" | "web";

/** Operations a UI may call. Dashboard session administration stays CLI-only. */
export const UI_OPERATIONS: ReadonlySet<string> = new Set([
  "overview", "providers", "profiles/discover", "profiles/inspect",
  "accounts/add", "accounts/set-nickname", "accounts/set-enabled", "accounts/removal-preview", "accounts/remove",
  "accounts/refresh", "accounts/login", "accounts/login-status", "accounts/login-command", "accounts/open-login", "accounts/cancel-login",
  "pools/save", "pools/remove", "grants/save", "integrations/revoke", "stop",
  "metrics/snapshot", "metrics/history", "requests/recent",
]);

/** The desktop shell may also force a stop when the app quits. */
const DESKTOP_OPERATIONS: ReadonlySet<string> = new Set([...UI_OPERATIONS, "shutdown"]);

const MAX_INFLIGHT = 16;
const MAX_SUBSCRIPTIONS = 16;
const HELLO_TIMEOUT_MS = 5_000;
export const MAX_MESSAGE_CHARS = 1024 * 1024;

export interface AppTransport {
  send(text: string): void;
  close(): void;
}

type Subscription =
  | { kind: "live" }
  | { kind: "requests" }
  | { kind: "history"; range: RangeName; scope: string; metrics: string[]; completeThrough: number };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class AppHub {
  private readonly owner: OwnerService;
  private readonly metrics: Metrics;
  private readonly routerId: () => string;
  private readonly sessions = new Set<AppSession>();
  private revision = 0;
  private changeTimer: NodeJS.Timeout | undefined;
  private lastChange = 0;
  private tick: NodeJS.Timeout | undefined;
  private calls = 0;
  private readonly unsubscribeMetrics: () => void;
  constructor(owner: OwnerService, metrics: Metrics, routerId: () => string) {
    this.owner = owner;
    this.metrics = metrics;
    this.routerId = routerId;
    this.unsubscribeMetrics = metrics.onEvent(event => {
      for (const session of this.sessions) session.request(event.entry);
    });
  }
  /** In-flight calls; long-lived idle connections do not count as busy. */
  inflight(): number { return this.calls; }
  open(kind: AppKind, transport: AppTransport, authenticated: boolean): AppSession {
    const session = new AppSession(this, kind, transport, authenticated);
    this.sessions.add(session);
    if (authenticated) session.hello();
    return session;
  }
  forget(session: AppSession): void {
    this.sessions.delete(session);
    this.schedule();
  }
  /** Coalesced to at most four notifications a second. */
  notifyChange(): void {
    if (this.changeTimer) return;
    const delay = Math.max(0, 250 - (Date.now() - this.lastChange));
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.lastChange = Date.now();
      this.revision++;
      for (const session of this.sessions) session.event({ event: "change", data: { revision: this.revision } });
    }, delay);
    this.changeTimer.unref();
  }
  get currentRevision(): number { return this.revision; }
  get id(): string { return this.routerId(); }
  authenticate(token: unknown): void {
    if (typeof token !== "string" || token.length > 200) throw new ControlError(401, "local owner credential required");
    this.owner.authenticate(`Bearer ${token}`);
  }
  async call(kind: AppKind, operation: unknown, body: unknown): Promise<unknown> {
    if (typeof operation !== "string" || !(kind === "desktop" ? DESKTOP_OPERATIONS : UI_OPERATIONS).has(operation)) throw new ControlError(404, "unknown app operation");
    const input = body === undefined ? {} : record(body);
    if (!input) throw new ControlError(400, "expected object");
    this.calls++;
    try { return await this.owner.operation(operation, adjust(kind, operation, structuredClone(input))); }
    finally { this.calls--; }
  }
  snapshot() { return this.metrics.snapshot(); }
  history(range: RangeName, scope: string, metrics: string[], after?: number) { return this.metrics.history(range, scope, metrics, after); }
  recent() { return this.metrics.recentRequests(); }
  /** One shared timer while any session holds a periodic subscription. */
  schedule(): void {
    const needed = [...this.sessions].some(s => s.periodic());
    if (needed && !this.tick) {
      this.tick = setInterval(() => {
        const live = this.metrics.snapshot();
        for (const session of this.sessions) session.periodicTick(live);
      }, 1000);
      this.tick.unref();
    } else if (!needed && this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
  }
  close(): void {
    for (const session of [...this.sessions]) session.close();
    if (this.tick) clearInterval(this.tick);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.tick = this.changeTimer = undefined;
    this.unsubscribeMetrics();
  }
}

/**
 * UI enrollment matches the official CLI's storage: on macOS, a new Claude
 * profile uses its own Keychain entry. The headless CLI keeps its defaults.
 */
function adjust(_kind: AppKind, operation: string, body: Record<string, unknown>): Record<string, unknown> {
  if (process.platform === "darwin" && operation === "accounts/add" && body.provider === "claude" && body.enrollment !== "existing" && body.credentialStore === undefined) {
    body.credentialStore = "claude-keychain";
  }
  return body;
}

export class AppSession {
  private readonly hub: AppHub;
  readonly kind: AppKind;
  private readonly transport: AppTransport;
  private authenticated: boolean;
  private closed = false;
  private inflight = 0;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly helloTimer: NodeJS.Timeout | undefined;
  constructor(hub: AppHub, kind: AppKind, transport: AppTransport, authenticated: boolean) {
    this.hub = hub;
    this.kind = kind;
    this.transport = transport;
    this.authenticated = authenticated;
    if (!authenticated) {
      this.helloTimer = setTimeout(() => this.close(), HELLO_TIMEOUT_MS);
      this.helloTimer.unref();
    }
  }
  hello(): void {
    this.send({ hello: { protocol: APP_PROTOCOL, routerId: this.hub.id, kind: this.kind, revision: this.hub.currentRevision } });
  }
  private send(message: object): void {
    if (this.closed) return;
    try { this.transport.send(JSON.stringify(message)); } catch { this.close(); }
  }
  event(message: object): void { if (this.authenticated) this.send(message); }
  receive(text: string): void {
    if (this.closed) return;
    let message: Record<string, unknown> | undefined;
    try { message = text.length <= MAX_MESSAGE_CHARS ? record(JSON.parse(text)) : undefined; } catch { message = undefined; }
    if (!message) { this.fail(undefined, 400, "invalid message"); return; }
    if (!this.authenticated) {
      // The first message on the desktop pipe proves owner authority.
      const hello = record(message.hello);
      try { this.hub.authenticate(hello?.token); }
      catch { this.send({ error: { status: 401, message: "local owner credential required" } }); this.close(); return; }
      clearTimeout(this.helloTimer);
      this.authenticated = true;
      this.hello();
      return;
    }
    const id = message.id;
    if (!Number.isSafeInteger(id) || (id as number) < 0) { this.fail(undefined, 400, "message id required"); return; }
    if (message.hello !== undefined) this.fail(id as number, 409, "already authenticated");
    else if (message.call !== undefined) void this.call(id as number, message.call, message.body);
    else if (message.subscribe !== undefined) this.subscribe(id as number, message.subscribe, message.body);
    else if (message.unsubscribe !== undefined) {
      this.subscriptions.delete(Number(message.unsubscribe));
      this.hub.schedule();
      this.send({ id, result: {} });
    } else this.fail(id as number, 400, "unknown message");
  }
  private fail(id: number | undefined, status: number, message: string): void {
    this.send({ ...(id === undefined ? {} : { id }), error: { status, message } });
  }
  private async call(id: number, operation: unknown, body: unknown): Promise<void> {
    if (this.inflight >= MAX_INFLIGHT) { this.fail(id, 503, "too many concurrent calls"); return; }
    this.inflight++;
    try { this.send({ id, result: await this.hub.call(this.kind, operation, body) }); }
    catch (error) {
      if (error instanceof ControlError) this.fail(id, error.status, error.message);
      else { log("app.call_failed", { operation: typeof operation === "string" ? operation.slice(0, 60) : "invalid", error: errorText(error) }); this.fail(id, 503, "operation unavailable"); }
    } finally { this.inflight--; }
  }
  private subscribe(id: number, kind: unknown, raw: unknown): void {
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS && !this.subscriptions.has(id)) { this.fail(id, 409, "too many subscriptions"); return; }
    const body = raw === undefined ? {} : record(raw);
    if (!body) { this.fail(id, 400, "expected object"); return; }
    if (kind === "live") {
      this.subscriptions.set(id, { kind: "live" });
      this.send({ id, result: this.hub.snapshot() });
    } else if (kind === "requests") {
      this.subscriptions.set(id, { kind: "requests" });
      this.send({ id, result: { requests: this.hub.recent() } });
    } else if (kind === "history") {
      const range = body.range ?? "10m", scope = body.scope ?? "all", metrics = body.metrics ?? [...COUNTERS];
      if (!isRange(range) || !isScope(scope) || !Array.isArray(metrics) || metrics.length > 16 || metrics.some(m => m !== "quota" && !isMetric(m))) {
        this.fail(id, 400, "invalid history subscription");
        return;
      }
      const snapshot = this.hub.history(range, scope, metrics as string[]);
      this.subscriptions.set(id, { kind: "history", range, scope, metrics: metrics as string[], completeThrough: snapshot.completeThrough });
      this.send({ id, result: snapshot });
    } else { this.fail(id, 400, "unknown subscription"); return; }
    this.hub.schedule();
  }
  periodic(): boolean { return [...this.subscriptions.values()].some(s => s.kind !== "requests"); }
  periodicTick(live: ReturnType<AppHub["snapshot"]>): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.kind === "live") this.send({ sub: id, event: "live", data: live });
      else if (sub.kind === "history" && Math.floor(live.at / RANGES[sub.range].bucketMs) - 1 > sub.completeThrough) {
        const data = this.hub.history(sub.range, sub.scope, sub.metrics, sub.completeThrough);
        sub.completeThrough = data.completeThrough;
        this.send({ sub: id, event: "history", data });
      }
    }
  }
  request(entry: unknown): void {
    for (const [id, sub] of this.subscriptions) if (sub.kind === "requests") this.send({ sub: id, event: "request", data: entry });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.subscriptions.clear();
    try { this.transport.close(); } catch { /* Already closed. */ }
    this.hub.forget(this);
  }
}

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * Desktop pipe: newline-delimited JSON on a private socket in the state
 * directory. The first line must be `{"hello":{"token":…}}` with the owner
 * credential; socket permissions are the bootstrap boundary.
 */
export async function startAppSocket(path: string, hub: AppHub): Promise<{ close(): Promise<void> }> {
  if (Buffer.byteLength(path) > 100) throw new Error("app socket path too long; choose a shorter state directory");
  // The caller already owns control.sock, so an existing app.sock is stale.
  if (existsSync(path)) {
    const stale = lstatSync(path);
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw new Error("app socket path is occupied by something else");
    unlinkSync(path);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setEncoding("utf8");
    const session = hub.open("desktop", {
      send: text => {
        if (socket.writableLength > MAX_BUFFERED_BYTES) { socket.destroy(); return; }
        socket.write(text + "\n");
      },
      close: () => socket.end(),
    }, false);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (line) session.receive(line);
      }
      if (buffer.length > MAX_MESSAGE_CHARS) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); session.close(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  const identity = lstatSync(path);
  return {
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
      if (existsSync(path)) {
        const current = lstatSync(path);
        if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
      }
    }),
  };
}
