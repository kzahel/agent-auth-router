// Loopback web dashboard: serves the management UI and carries the app
// protocol over a WebSocket. A single-use access code from `aar serve` or
// `aar dashboard url` becomes a long-lived HttpOnly session cookie. Exact
// Host and Origin checks protect against DNS rebinding and cross-site use;
// the page never receives the owner credential.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, watch, type FSWatcher } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppHub, MAX_MESSAGE_CHARS } from "./app.ts";
import { ControlError } from "./control.ts";
import { errorText, log } from "./log.ts";
import type { DashboardControl } from "./owner.ts";
import { writePrivateJson, type StateStore } from "./state.ts";
import { acceptWebSocket } from "./websocket.ts";

export const DEFAULT_DASHBOARD_PORT = 8418;
const CODE_TTL_MS = 60 * 60_000;
const MAX_CODES = 16;
const MAX_SESSIONS = 64;
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const TOUCH_INTERVAL_MS = 60 * 60_000;

/** The shared UI: bundled beside the core (resources/ui), or a source checkout's desktop/ui. */
export function defaultUiDir(): string {
  const candidates = ["../ui/", "../desktop/ui/"].map(path => resolve(fileURLToPath(new URL(path, import.meta.url))));
  return candidates.find(dir => existsSync(join(dir, "index.html"))) ?? candidates.at(-1)!;
}

/** Files the browser may load. Desktop-only terminal assets are not served. */
export const ASSETS: Record<string, string> = {
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/app-client.js": "text/javascript; charset=utf-8",
  "/dashboard.js": "text/javascript; charset=utf-8",
  "/graph.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};

interface Session { id: string; tokenHash: string; createdAt: string; lastUsedAt: string; userAgent: string | null }
interface SessionFile { version: 1; sessions: Session[] }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equalHash = (a: string, b: string) => a.length === 64 && b.length === 64 && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export interface Dashboard extends DashboardControl {
  port: number;
  close(): Promise<void>;
}

export async function startDashboard(options: { store: StateStore; hub: AppHub; authenticateOwner: (header: string | undefined) => void; port: number; uiDir?: string; dev?: boolean }): Promise<Dashboard> {
  const { store, hub } = options;
  const uiDir = options.uiDir ?? defaultUiDir();
  if (!existsSync(join(uiDir, "index.html"))) throw new Error(`dashboard UI files not found in ${uiDir}`);
  const sessionsPath = join(store.dir, "dashboard-sessions.json");
  const codes = new Map<string, number>();
  let sessions = loadSessions(sessionsPath);
  let port = options.port;
  let cookieName = "";
  const sockets = new Set<import("node:stream").Duplex>();
  // Development: reload signed-in browsers when a served UI file changes.
  let watcher: FSWatcher | undefined, reloadTimer: NodeJS.Timeout | undefined;
  if (options.dev) {
    watcher = watch(uiDir, (_event, file) => {
      if (!file || !ASSETS[`/${file}`]) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => hub.broadcast("web", { event: "ui-reload", data: { file } }), 100);
    });
    watcher.unref();
  }

  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hostAllowed = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  /** Browser requests must come from this exact origin. */
  const originAllowed = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return typeof origin === "string" && origins().has(origin) && origin === `http://${req.headers.host}`;
  };
  const cookie = (req: IncomingMessage): string | undefined => {
    for (const part of String(req.headers.cookie ?? "").split(/;\s*/)) {
      const at = part.indexOf("=");
      if (at > 0 && part.slice(0, at) === cookieName) return part.slice(at + 1);
    }
    return undefined;
  };
  const session = (req: IncomingMessage): Session | undefined => {
    const token = cookie(req);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const tokenHash = hash(token);
    const found = sessions.find(s => equalHash(s.tokenHash, tokenHash));
    if (found && Date.now() - Date.parse(found.lastUsedAt) > TOUCH_INTERVAL_MS) {
      found.lastUsedAt = new Date().toISOString();
      saveSessions();
    }
    return found;
  };
  function saveSessions(): void {
    try { writePrivateJson(sessionsPath, { version: 1, sessions } satisfies SessionFile); }
    catch (error) { log("dashboard.sessions_save_failed", { error: errorText(error) }); }
  }
  const headers = (extra: Record<string, string> = {}) => ({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
  const json = (res: ServerResponse, status: number, body: object, extra: Record<string, string> = {}) => {
    res.writeHead(status, headers({ "content-type": "application/json", ...extra }));
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new ControlError(415, "JSON body required");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 16_384) throw new ControlError(413, "request too large");
      chunks.push(chunk as Buffer);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new ControlError(400, "invalid JSON request"); }
  };

  const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    void (async () => {
      if (!hostAllowed(req)) return json(res, 403, { error: "invalid host" });
      const url = new URL(req.url ?? "/", "http://dashboard.invalid");
      const path = url.pathname;
      if (req.method === "GET" && (path === "/" || ASSETS[path])) {
        const file = path === "/" ? "/index.html" : path;
        let content: Buffer;
        try { content = readFileSync(join(uiDir, file.slice(1))); } catch { return json(res, 404, { error: "not found" }); }
        const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
        res.writeHead(200, headers({ "content-type": ASSETS[file]!, "content-security-policy": csp }));
        res.end(content);
        return;
      }
      if (path === "/auth/status" && req.method === "GET") return json(res, 200, { authenticated: !!session(req) });
      if (path === "/auth/exchange" && req.method === "POST") {
        if (!originAllowed(req)) return json(res, 403, { error: "invalid origin" });
        const body = await readJson(req);
        const code = typeof body.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.code) ? body.code : undefined;
        const codeHash = code ? hash(code) : "";
        const expiry = code ? codes.get(codeHash) : undefined;
        if (!code || expiry === undefined || expiry < Date.now()) {
          if (code) codes.delete(codeHash);
          return json(res, 401, { error: "Access link expired or already used. Run `aar dashboard url` for a new one." });
        }
        codes.delete(codeHash);
        const token = randomBytes(32).toString("base64url"), now = new Date().toISOString();
        const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 200) : null;
        sessions.push({ id: randomUUID(), tokenHash: hash(token), createdAt: now, lastUsedAt: now, userAgent });
        sessions.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
        sessions = sessions.slice(0, MAX_SESSIONS);
        saveSessions();
        return json(res, 200, { authenticated: true }, { "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}` });
      }
      if (path === "/auth/logout" && req.method === "POST") {
        if (!originAllowed(req)) return json(res, 403, { error: "invalid origin" });
        const current = session(req);
        if (current) { sessions = sessions.filter(s => s !== current); saveSessions(); }
        return json(res, 200, { authenticated: false }, { "set-cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (path.startsWith("/v1/app/") && req.method === "POST") {
        // Browsers need the session cookie and an exact Origin. Scripts may
        // instead present the owner credential; browsers cannot send it
        // cross-origin without a CORS preflight this server never grants.
        if (req.headers.authorization !== undefined) {
          if (req.headers.origin !== undefined && !originAllowed(req)) return json(res, 403, { error: "invalid origin" });
          try { options.authenticateOwner(req.headers.authorization); } catch { return json(res, 401, { error: "local owner credential required" }); }
        } else {
          if (!originAllowed(req)) return json(res, 403, { error: "invalid origin" });
          if (!session(req)) return json(res, 401, { error: "dashboard session required" });
        }
        const body = await readJson(req);
        return json(res, 200, { result: await hub.call("web", path.slice("/v1/app/".length), body) });
      }
      json(res, req.method === "GET" || req.method === "POST" ? 404 : 405, { error: "not found" });
    })().catch((error: unknown) => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof ControlError) json(res, error.status, { error: error.message });
      else { log("dashboard.request_failed", { error: errorText(error) }); json(res, 503, { error: "dashboard request failed" }); }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    const deny = (status: number, reason: string) => socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    // Browsers apply no CORS to WebSockets: Origin and cookie are both required.
    if (!hostAllowed(req) || !originAllowed(req)) return deny(403, "Forbidden");
    if (new URL(req.url ?? "/", "http://dashboard.invalid").pathname !== "/v1/app/ws") return deny(404, "Not Found");
    if (!session(req)) return deny(401, "Unauthorized");
    if (sockets.size >= 32) return deny(503, "Service Unavailable");
    const ws = acceptWebSocket(req, socket, head, MAX_MESSAGE_CHARS * 4);
    if (!ws) return;
    sockets.add(socket);
    const app = hub.open("web", { send: text => ws.send(text), close: () => ws.close() }, true);
    ws.onMessage(text => app.receive(text));
    ws.onClose(() => { sockets.delete(socket); app.close(); });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
      ? new Error(`dashboard port ${options.port} is in use; choose another with --dashboard-port or AAR_DASHBOARD_PORT, or disable it with --no-dashboard`)
      : error));
    server.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  cookieName = `aar_dashboard_${port}`;
  const origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    mintCode() {
      const now = Date.now();
      for (const [key, expiry] of codes) if (expiry < now) codes.delete(key);
      while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value!);
      const code = randomBytes(32).toString("base64url");
      codes.set(hash(code), now + CODE_TTL_MS);
      return { url: `${origin}/#code=${code}`, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
    },
    sessions: () => sessions.map(({ id, createdAt, lastUsedAt, userAgent }) => ({ id, createdAt, lastUsedAt, userAgent })),
    revoke(id) {
      const before = sessions.length;
      sessions = id ? sessions.filter(s => s.id !== id) : [];
      if (sessions.length !== before) saveSessions();
      return before - sessions.length;
    },
    close: () => new Promise<void>(resolveClose => {
      watcher?.close();
      clearTimeout(reloadTimer);
      for (const socket of sockets) socket.destroy();
      server.close(() => resolveClose());
      server.closeAllConnections();
    }),
  };
}

function loadSessions(path: string): Session[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("insecure dashboard session state");
  const value = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  if (value?.version !== 1 || !Array.isArray(value.sessions)) throw new Error("unsupported dashboard session state");
  return value.sessions.filter(s => s && typeof s.id === "string" && /^[a-f0-9]{64}$/.test(s.tokenHash) && typeof s.lastUsedAt === "string").slice(0, MAX_SESSIONS);
}
