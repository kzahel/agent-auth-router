// App protocol client shared by the desktop and web shells. Only the port
// differs: Tauri relays newline-delimited JSON from the core's private
// socket; the browser uses a loopback WebSocket. Everything above the port
// (request ids, subscriptions, reconnects) is the same code.

export class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Desktop: Rust authenticates and relays messages; the webview never holds credentials. */
export async function tauriPort() {
  const tauri = window.__TAURI__;
  const invoke = (...args) => tauri.core.invoke(...args);
  let onMessage = () => {}, onClose = () => {};
  await tauri.event.listen("app-message", ({ payload }) => onMessage(payload));
  await tauri.event.listen("app-closed", () => onClose());
  return {
    kind: "desktop",
    connect: (start) => invoke("app_connect", { start }),
    send: (message) => invoke("app_send", { message }),
    onMessage: (handler) => { onMessage = handler; },
    onClose: (handler) => { onClose = handler; },
    shell: {
      native: true,
      terminalLogin: (id, presentation) => invoke("terminal_login", { id, presentation }),
      startup: (enabled) => invoke("startup", { enabled }),
      checkUpdate: () => invoke("check_update"),
      installUpdate: (version) => invoke("install_update", { version }),
      onLifecycleError: (handler) => tauri.event.listen("router-lifecycle-error", ({ payload }) => handler(payload)),
    },
  };
}

/** Browser: exchanges a one-time access code for a session cookie, then uses a WebSocket. */
export function webSocketPort() {
  let socket, onMessage = () => {}, onClose = () => {};
  const post = async (path, body) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(value.error ?? "Dashboard request failed", response.status);
    return value;
  };
  return {
    kind: "web",
    /** Signs in with a `#code=` link if present, then reports the session state. */
    async authenticate() {
      const code = new URLSearchParams(location.hash.slice(1)).get("code");
      if (code) {
        // Remove the code from history first; it is single-use either way.
        history.replaceState(null, "", location.pathname + location.search);
        try { await post("/auth/exchange", { code }); } catch (failure) { return { authenticated: false, error: failure.message }; }
      }
      const status = await fetch("/auth/status", { credentials: "same-origin" }).then(r => r.json());
      return { authenticated: !!status.authenticated };
    },
    connect: () => new Promise((resolve, reject) => {
      socket?.close();
      const current = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/app/ws`);
      let ready = false;
      current.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
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

export class AppClient {
  #port;
  #nextId = 1;
  #pending = new Map();
  #subscriptions = new Map();
  #changeListeners = new Set();
  #statusListeners = new Set();
  #retry;
  #retryDelay = 1000;
  #connecting;
  connected = false;
  hello;
  constructor(port) {
    this.#port = port;
    port.onMessage((message) => this.#message(message));
    port.onClose(() => this.#closed());
  }
  get kind() { return this.#port.kind; }
  get shell() { return this.#port.shell; }
  /** `startCore` lets the desktop start a stopped core; reconnection never does. */
  start(startCore = false) {
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
  onChange(listener) { this.#changeListeners.add(listener); return () => this.#changeListeners.delete(listener); }
  onStatus(listener) { this.#statusListeners.add(listener); return () => this.#statusListeners.delete(listener); }
  call(operation, body = {}) {
    if (!this.connected) return Promise.reject(new AppError("Router unavailable"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      Promise.resolve().then(() => this.#port.send({ id, call: operation, body })).catch((failure) => {
        this.#pending.delete(id);
        reject(failure instanceof Error ? failure : new AppError(String(failure)));
      });
    });
  }
  /** Handler receives `{ type: "snapshot" | <event>, data }`; snapshots repeat after reconnects. */
  subscribe(kind, body, handler) {
    const subscription = { kind, body, handler, remoteId: undefined };
    const key = Symbol(kind);
    this.#subscriptions.set(key, subscription);
    if (this.connected) this.#sendSubscribe(subscription);
    return () => {
      this.#subscriptions.delete(key);
      if (this.connected && subscription.remoteId !== undefined) {
        const id = this.#nextId++;
        Promise.resolve().then(() => this.#port.send({ id, unsubscribe: subscription.remoteId })).catch(() => {});
      }
    };
  }
  #sendSubscribe(subscription) {
    const id = subscription.remoteId = this.#nextId++;
    Promise.resolve().then(() => this.#port.send({ id, subscribe: subscription.kind, body: subscription.body })).catch(() => {});
  }
  #message(message) {
    // Dev mode (`aar serve --dev`): a served UI file changed.
    if (message.event === "ui-reload" && this.kind === "web") { location.reload(); return; }
    if (message.event === "change" && message.sub === undefined) {
      for (const listener of this.#changeListeners) listener(message.data);
      return;
    }
    if (message.sub !== undefined) {
      for (const subscription of this.#subscriptions.values()) {
        if (subscription.remoteId === message.sub) subscription.handler({ type: message.event, data: message.data });
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending) {
      this.#pending.delete(message.id);
      if ("result" in message) pending.resolve(message.result);
      else pending.reject(new AppError(message.error?.message ?? "Router request failed", message.error?.status));
      return;
    }
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.remoteId !== message.id) continue;
      if ("result" in message) subscription.handler({ type: "snapshot", data: message.result });
      else subscription.handler({ type: "error", data: message.error });
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
  #status(state) { for (const listener of this.#statusListeners) listener(state); }
}
