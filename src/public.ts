// Opt-in public listener: one loopback port that a TLS reverse proxy exposes
// at a public HTTPS origin. It dispatches by path prefix to the existing
// surfaces, each keeping its own credential class and authorization path:
// /claude and /codex reach inference, /control/ reaches integration control
// (never owner administration), everything else reaches the dashboard.
// AAR never binds a non-loopback address; the proxy is the deliberate bind.

import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { isProvider } from "./types.ts";

export const CONTROL_PREFIX = "/control";

export interface PublicSurfaces {
  inference: RequestListener;
  control: (req: IncomingMessage, res: ServerResponse) => void;
  dashboard?: {
    request: (req: IncomingMessage, res: ServerResponse) => void;
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  };
}

export interface PublicListener {
  origin: string;
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

/** Validates an `https://host[:port]` origin with nothing else in it. */
export function parsePublicOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("public origin must be an https URL such as https://aar.example.com"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname)
    throw new Error("public origin must be an https URL with only a host, such as https://aar.example.com");
  return url;
}

/** The client address the reverse proxy saw, for display and rate limits only. */
export function clientAddress(req: IncomingMessage): string | null {
  const peer = req.socket.remoteAddress ?? null;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return peer;
  // The proxy appends the address it saw; earlier entries are client-supplied.
  const last = forwarded.split(",").at(-1)?.trim();
  return last && last.length <= 64 && /^[0-9a-fA-F:.]+$/.test(last) ? last : peer;
}

function surface(path: string): "inference" | "control" | "dashboard" {
  if (isProvider(path.split(/[/?]/, 2)[1])) return "inference";
  if (path === CONTROL_PREFIX || path.startsWith(`${CONTROL_PREFIX}/`) || path.startsWith(`${CONTROL_PREFIX}?`)) return "control";
  return "dashboard";
}

export async function startPublic(options: { origin: string; port: number; surfaces: PublicSurfaces; maxHeaderBytes: number; requestTimeoutMs: number }): Promise<PublicListener> {
  const origin = parsePublicOrigin(options.origin);
  const host = origin.host.toLowerCase();
  const sockets = new Set<Duplex>();
  const deny = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  const server = http.createServer({ maxHeaderSize: Math.max(options.maxHeaderBytes, 16_384) }, (req, res) => {
    // Exact Host, as the proxy forwards it, defeats DNS rebinding to this port.
    if (req.headers.host?.toLowerCase() !== host) { deny(res, 421, "unknown host"); req.resume(); return; }
    const url = req.url ?? "";
    if (!url.startsWith("/")) { deny(res, 400, "only origin-form request targets are accepted"); req.resume(); return; }
    const kind = surface(url);
    if (kind === "inference") return options.surfaces.inference(req, res);
    if (kind === "control") {
      req.url = url.slice(CONTROL_PREFIX.length) || "/";
      return options.surfaces.control(req, res);
    }
    if (!options.surfaces.dashboard) { deny(res, 404, "not found"); req.resume(); return; }
    options.surfaces.dashboard.request(req, res);
  });
  server.headersTimeout = Math.min(options.requestTimeoutMs, 60_000);
  server.requestTimeout = options.requestTimeoutMs;
  server.on("upgrade", (req, socket, head) => {
    const refuse = (status: number, reason: string) => socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    if (req.headers.host?.toLowerCase() !== host) return refuse(421, "Misdirected Request");
    if (!options.surfaces.dashboard || surface(req.url ?? "") !== "dashboard") return refuse(501, "Not Implemented");
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    options.surfaces.dashboard.upgrade(req, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
      ? new Error(`public port ${options.port} is in use; choose another with --public-port or AAR_PUBLIC_PORT`)
      : error));
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  return {
    origin: origin.origin,
    port: (server.address() as AddressInfo).port,
    server,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
  };
}
