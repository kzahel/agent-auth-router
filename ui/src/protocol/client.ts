// App protocol client shared by the desktop and web shells. Only the port
// differs: Tauri relays newline-delimited JSON from the core's private
// socket; the browser uses a loopback WebSocket. Everything above the port
// (request ids, subscriptions, reconnects) is the same code.

export class AppError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface Hello { protocol: number; routerId: string; kind: "desktop" | "web" }

/** A message from the core: a reply, a subscription event or a broadcast. */
export interface Inbound {
  id?: number;
  sub?: number;
  event?: string;
  data?: unknown;
  result?: unknown;
  error?: { status?: number; message?: string };
  hello?: Hello;
}

export type Outbound =
  | { id: number; call: string; body: unknown }
  | { id: number; subscribe: string; body: unknown }
  | { id: number; unsubscribe: number };

/** Features only one shell has. `native` is true in the desktop app. */
export interface DesktopShell {
  native: true;
  terminalLogin(id: string, presentation: string): Promise<unknown>;
  startup(enabled: boolean | null): Promise<boolean>;
  openProject(): Promise<unknown>;
  checkUpdate(): Promise<{ version?: string }>;
  installUpdate(version: string): Promise<unknown>;
  onLifecycleError(handler: (payload: unknown) => void): Promise<unknown>;
}
export interface WebShell {
  native: false;
  logout(): Promise<unknown>;
}

export interface Port {
  kind: "desktop" | "web";
  /** `start` lets the desktop start a stopped core. */
  connect(start: boolean): Promise<Hello>;
  send(message: Outbound): unknown;
  onMessage(handler: (message: Inbound) => void): void;
  onClose(handler: () => void): void;
  shell: DesktopShell | WebShell;
}

interface Tauri {
  core: { invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T = unknown>(name: string, handler: (event: { payload: T }) => void): Promise<() => void> };
  window: { getCurrentWindow(): { close(): Promise<void> } };
}
declare global {
  interface Window { __TAURI__?: Tauri }
}

/** Desktop: Rust authenticates and relays messages; the webview never holds credentials. */
export async function tauriPort(): Promise<Port> {
  const tauri = window.__TAURI__!;
  const invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => tauri.core.invoke<T>(command, args);
  let onMessage: (message: Inbound) => void = () => {}, onClose = () => {};
  await tauri.event.listen<Inbound>("app-message", ({ payload }) => onMessage(payload));
  await tauri.event.listen("app-closed", () => onClose());
  return {
    kind: "desktop",
    connect: (start) => invoke<Hello>("app_connect", { start }),
    send: (message) => invoke("app_send", { message }),
    onMessage: (handler) => { onMessage = handler; },
    onClose: (handler) => { onClose = handler; },
    shell: {
      native: true,
      terminalLogin: (id, presentation) => invoke("terminal_login", { id, presentation }),
      startup: (enabled) => invoke<boolean>("startup", { enabled }),
      openProject: () => invoke("open_project"),
      checkUpdate: () => invoke<{ version?: string }>("check_update"),
      installUpdate: (version) => invoke("install_update", { version }),
      onLifecycleError: (handler) => tauri.event.listen("router-lifecycle-error", ({ payload }) => handler(payload)),
    },
  };
}

export interface WebPort extends Port {
  /** Signs in with a `#code=` link if present, then reports the session state. */
  authenticate(): Promise<{ authenticated: boolean; error?: string }>;
}

/** Browser: exchanges a one-time access code for a session cookie, then uses a WebSocket. */
export function webSocketPort(): WebPort {
  let socket: WebSocket | undefined, onMessage: (message: Inbound) => void = () => {}, onClose = () => {};
  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const value = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new AppError(value.error ?? "Dashboard request failed", response.status);
    return value;
  };
  return {
    kind: "web",
    async authenticate() {
      const code = new URLSearchParams(location.hash.slice(1)).get("code");
      if (code) {
        // Remove the code from history first; it is single-use either way.
        history.replaceState(null, "", location.pathname + location.search);
        try { await post("/auth/exchange", { code }); } catch (failure) { return { authenticated: false, error: (failure as Error).message }; }
      }
      const status = await fetch("/auth/status", { credentials: "same-origin" }).then(r => r.json()) as { authenticated?: boolean };
      return { authenticated: !!status.authenticated };
    },
    connect: () => new Promise((resolve, reject) => {
      socket?.close();
      const current = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/app/ws`);
      let ready = false;
      current.onmessage = (event) => {
        let message: Inbound;
        try { message = JSON.parse(event.data as string) as Inbound; } catch { return; }
        if (!ready) {
          if (message.hello) { ready = true; resolve(message.hello); }
          else reject(new AppError(message.error?.message ?? "Dashboard connection refused"));
          return;
        }
        onMessage(message);
      };
      current.onclose = () => {
        if (socket !== current) return;
        if (!ready) reject(new AppError("Router unavailable or this browser is signed out"));
        else onClose();
      };
    }),
    send: (message) => {
      if (socket?.readyState !== WebSocket.OPEN) throw new AppError("Router connection closed");
      socket.send(JSON.stringify(message));
    },
    onMessage: (handler) => { onMessage = handler; },
    onClose: (handler) => { onClose = handler; },
    shell: {
      native: false,
      logout: () => post("/auth/logout", {}),
    },
  };
}

/** What a subscription handler receives: the snapshot (again after reconnects), events and errors. */
export type SubscriptionMessage<T = unknown> =
  | { type: "snapshot"; data: T }
  | { type: "error"; data: { status?: number; message?: string } }
  | { type: string; data: unknown };

interface Subscription {
  kind: string;
  body: unknown;
  handler: (message: SubscriptionMessage) => void;
  remoteId: number | undefined;
}

export type ConnectionState = "connected" | "disconnected";

export class AppClient {
  #port: Port;
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  #subscriptions = new Map<symbol, Subscription>();
  #changeListeners = new Set<(data: unknown) => void>();
  #statusListeners = new Set<(state: ConnectionState) => void>();
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = 1000;
  #connecting: Promise<Hello> | undefined;
  connected = false;
  hello: Hello | undefined;
  constructor(port: Port) {
    this.#port = port;
    port.onMessage((message) => this.#message(message));
    port.onClose(() => this.#closed());
  }
  get kind() { return this.#port.kind; }
  get shell() { return this.#port.shell; }
  /** `startCore` lets the desktop start a stopped core; reconnection never does. */
  start(startCore = false): Promise<Hello> {
    clearTimeout(this.#retry);
    return (this.#connecting ??= (async () => {
      try {
        this.hello = await this.#port.connect(startCore);
        this.connected = true;
        this.#retryDelay = 1000;
        for (const subscription of this.#subscriptions.values()) this.#sendSubscribe(subscription);
        this.#status("connected");
        return this.hello;
      } catch (failure) {
        this.#retryDelay = Math.min(this.#retryDelay * 2, 10_000);
        this.#scheduleRetry();
        throw failure;
      } finally { this.#connecting = undefined; }
    })());
  }
  onChange(listener: (data: unknown) => void) { this.#changeListeners.add(listener); return () => { this.#changeListeners.delete(listener); }; }
  onStatus(listener: (state: ConnectionState) => void) { this.#statusListeners.add(listener); return () => { this.#statusListeners.delete(listener); }; }
  call<T = unknown>(operation: string, body: object = {}): Promise<T> {
    if (!this.connected) return Promise.reject(new AppError("Router unavailable"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      Promise.resolve().then(() => this.#port.send({ id, call: operation, body })).catch((failure: unknown) => {
        this.#pending.delete(id);
        reject(failure instanceof Error ? failure : new AppError(String(failure)));
      });
    });
  }
  /** Handler receives `{ type: "snapshot" | <event>, data }`; snapshots repeat after reconnects. */
  subscribe<T = unknown>(kind: string, body: object, handler: (message: SubscriptionMessage<T>) => void): () => void {
    const subscription: Subscription = { kind, body, handler: handler as (message: SubscriptionMessage) => void, remoteId: undefined };
    const key = Symbol(kind);
    this.#subscriptions.set(key, subscription);
    if (this.connected) this.#sendSubscribe(subscription);
    return () => {
      this.#subscriptions.delete(key);
      if (this.connected && subscription.remoteId !== undefined) {
        const id = this.#nextId++, remote = subscription.remoteId;
        Promise.resolve().then(() => this.#port.send({ id, unsubscribe: remote })).catch(() => {});
      }
    };
  }
  #sendSubscribe(subscription: Subscription) {
    const id = subscription.remoteId = this.#nextId++;
    Promise.resolve().then(() => this.#port.send({ id, subscribe: subscription.kind, body: subscription.body })).catch(() => {});
  }
  #message(message: Inbound) {
    // Dev mode (`aar serve --dev`): a served UI file changed.
    if (message.event === "ui-reload" && this.kind === "web") { location.reload(); return; }
    if (message.event === "change" && message.sub === undefined) {
      for (const listener of this.#changeListeners) listener(message.data);
      return;
    }
    if (message.sub !== undefined) {
      for (const subscription of this.#subscriptions.values()) {
        if (subscription.remoteId === message.sub) subscription.handler({ type: message.event ?? "", data: message.data });
      }
      return;
    }
    const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
    if (pending) {
      this.#pending.delete(message.id!);
      if ("result" in message) pending.resolve(message.result);
      else pending.reject(new AppError(message.error?.message ?? "Router request failed", message.error?.status));
      return;
    }
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.remoteId !== message.id) continue;
      if ("result" in message) subscription.handler({ type: "snapshot", data: message.result });
      else subscription.handler({ type: "error", data: message.error ?? {} });
    }
  }
  #closed() {
    this.connected = false;
    for (const pending of this.#pending.values()) pending.reject(new AppError("Router connection closed"));
    this.#pending.clear();
    this.#status("disconnected");
    this.#scheduleRetry();
  }
  #scheduleRetry() {
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => { this.start(false).catch(() => {}); }, this.#retryDelay);
  }
  /** Stops automatic reconnection, for example after the owner stops the router. */
  pause() { clearTimeout(this.#retry); }
  #status(state: ConnectionState) { for (const listener of this.#statusListeners) listener(state); }
}
