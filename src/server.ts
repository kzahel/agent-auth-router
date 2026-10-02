import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import { authorize } from "./gateway-auth.ts";
import { CredentialUnavailable, type CredentialCoordinator } from "./coordinator.ts";
import { errorText, log } from "./log.ts";
import { ADAPTERS, parseUpstreamOrigin, relayableResponseHeaders, type ProviderAdapter, type Route } from "./providers.ts";
import { DEFAULT_LIMITS, isProvider, type GatewayClientRecord, type Limits, type Provider, type RouterConfig, type UpstreamCredential } from "./types.ts";

export interface RouterDeps {
  config: RouterConfig;
  clients: () => readonly GatewayClientRecord[];
  coordinators: ReadonlyMap<string, CredentialCoordinator>;
}

export interface RouterServer {
  server: http.Server;
  activeRequests(): number;
}

const MAX_RELAYED_ERROR_BYTES = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  constructor(status: number, message: string, headers: OutgoingHttpHeaders = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Errors in each provider's native shape so clients surface them sensibly. */
function errorBody(provider: Provider | undefined, status: number, message: string): string {
  if (provider === "claude") {
    const type =
      status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 413 ? "request_too_large" : "api_error";
    return JSON.stringify({ type: "error", error: { type, message } });
  }
  return JSON.stringify({ error: { message, type: "agent_auth_router_error", code: status } });
}

export function createRouter(deps: RouterDeps): RouterServer {
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.config.limits };
  const origins = new Map<Provider, URL>();
  for (const provider of Object.keys(ADAPTERS) as Provider[]) {
    origins.set(provider, parseUpstreamOrigin(deps.config.upstreams?.[provider] ?? ADAPTERS[provider].defaultOrigin));
  }
  let active = 0;

  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes }, (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    const meta: Record<string, string | number | undefined> = { requestId, method: req.method };

    const fail = (error: unknown) => {
      const provider = isProvider(meta.provider) ? meta.provider : undefined;
      const httpError =
        error instanceof HttpError
          ? error
          : error instanceof CredentialUnavailable
            ? new HttpError(
                503,
                `upstream account unavailable: ${error.message}`,
                error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : {},
              )
            : new HttpError(502, "upstream request failed");
      if (!(error instanceof HttpError || error instanceof CredentialUnavailable)) meta.error = errorText(error);
      meta.status = httpError.status;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(httpError.status, { "content-type": "application/json", ...httpError.headers });
      res.end(errorBody(provider, httpError.status, httpError.message));
    };

    active++;
    res.on("close", () => {
      active--;
      meta.durationMs = Date.now() - started;
      meta.status ??= res.statusCode;
      if (!res.writableFinished) meta.outcome = "client_closed";
      log("request", meta);
    });

    if (active > limits.maxActiveRequests) {
      fail(new HttpError(503, "router is at its active request limit", { "retry-after": "1" }));
      return;
    }

    handle(req, res, meta).catch(fail);
  });

  server.headersTimeout = Math.min(limits.clientRequestTimeoutMs, 60_000);
  server.requestTimeout = limits.clientRequestTimeoutMs;

  // WebSocket and other upgrades are not assessed yet; refuse them explicitly.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });

  async function handle(req: IncomingMessage, res: ServerResponse, meta: Record<string, string | number | undefined>) {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("/")) throw new HttpError(400, "only origin-form request targets are accepted");
    const url = new URL(rawUrl, "http://router.invalid");
    const [, prefix, ...rest] = url.pathname.split("/");
    if (!isProvider(prefix)) throw new HttpError(404, "unknown route");
    const provider = prefix;
    meta.provider = provider;
    const adapter = ADAPTERS[provider];
    const subpath = "/" + rest.join("/");
    const route = adapter.routes.find((candidate) => candidate.path === subpath && candidate.method === req.method);
    if (!route) {
      const pathKnown = adapter.routes.some((candidate) => candidate.path === subpath);
      throw new HttpError(pathKnown ? 405 : 404, pathKnown ? "method not allowed" : "unknown route");
    }
    meta.route = route.path;

    // Authenticate before any upstream or credential work.
    const decision = authorize(deps.clients(), req.headers, provider);
    if (!decision.ok) throw new HttpError(decision.status, decision.message);
    meta.client = decision.client.name;
    meta.account = decision.accountId;
    const coordinator = deps.coordinators.get(decision.accountId);
    if (!coordinator || coordinator.account.provider !== provider || coordinator.account.enabled === false) {
      throw new HttpError(503, "assigned upstream account is not available");
    }

    const body = await readBody(req, limits.maxBodyBytes);
    let clientClosed = false;
    res.once("close", () => {
      clientClosed = !res.writableFinished;
    });
    const clientGone = () => clientClosed;

    let credential = await coordinator.credential();
    let attempt = await forward(adapter, route, origins.get(provider)!, credential, req, body, res, meta);
    if (attempt.kind === "unauthorized") {
      // Rejected before generation: one coordinated recovery, one retry.
      const recovered = clientGone() ? undefined : await coordinator.recoverFromUnauthorized(credential);
      if (recovered) {
        meta.retried = 1;
        credential = recovered;
        attempt = await forward(adapter, route, origins.get(provider)!, credential, req, body, res, meta);
      }
      if (attempt.kind === "unauthorized") {
        coordinator.markRejected("upstream rejected the account credential");
        meta.upstreamStatus = 401;
        const headers = relayableResponseHeaders(attempt.headers);
        delete headers["content-length"];
        res.writeHead(401, headers);
        res.end(attempt.body);
      }
    }
  }

  function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) {
      req.resume();
      return Promise.reject(new HttpError(413, "request body too large"));
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          reject(new HttpError(413, "request body too large"));
          req.removeAllListeners("data");
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
      req.on("close", () => {
        if (!req.complete) reject(new HttpError(499, "client closed request"));
      });
    });
  }

  type Attempt =
    | { kind: "relayed" }
    | { kind: "unauthorized"; headers: http.IncomingHttpHeaders; body: Buffer };

  function forward(
    adapter: ProviderAdapter,
    route: Route,
    origin: URL,
    credential: UpstreamCredential,
    req: IncomingMessage,
    body: Buffer,
    res: ServerResponse,
    meta: Record<string, string | number | undefined>,
  ): Promise<Attempt> {
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && adapter.forwardHeader(name)) headers[name] = value;
    }
    Object.assign(headers, adapter.upstreamHeaders(credential, req.headers));
    headers["content-length"] = String(body.length);
    const query = new URL(req.url ?? "/", "http://router.invalid").search;
    const transport = origin.protocol === "https:" ? https : http;

    return new Promise<Attempt>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(headerTimer);
        fn();
      };
      const upstream = transport.request({
        protocol: origin.protocol,
        hostname: origin.hostname.replace(/^\[|\]$/g, ""),
        port: origin.port || undefined,
        method: route.method,
        path: route.upstreamPath + query,
        headers,
        // Fixed origin, no redirect following: Node's client never follows.
      });
      const headerTimer = setTimeout(() => {
        upstream.destroy(new Error("upstream response headers timed out"));
      }, limits.upstreamHeadersTimeoutMs);

      // Client cancellation tears down upstream work.
      const onClientClose = () => {
        if (!res.writableFinished) upstream.destroy(new Error("client closed"));
      };
      res.on("close", onClientClose);

      upstream.on("error", (error) => done(() => reject(error)));
      upstream.on("response", (upstreamRes) => {
        clearTimeout(headerTimer);
        upstream.setTimeout(limits.streamIdleTimeoutMs, () => upstream.destroy(new Error("upstream stream idle timeout")));
        const status = upstreamRes.statusCode ?? 502;

        if (status === 401) {
          collectBounded(upstreamRes, MAX_RELAYED_ERROR_BYTES).then(
            (errorBody) => done(() => {
              res.off("close", onClientClose);
              resolve({ kind: "unauthorized", headers: upstreamRes.headers, body: errorBody });
            }),
            (error) => done(() => reject(error)),
          );
          return;
        }
        if (status >= 300 && status < 400) {
          upstreamRes.resume();
          done(() => reject(new HttpError(502, "upstream redirect refused")));
          return;
        }

        done(() => {
          meta.upstreamStatus = status;
          res.writeHead(status, relayableResponseHeaders(upstreamRes.headers));
          res.flushHeaders();
          pipeline(upstreamRes, res, (error) => {
            if (error && !res.destroyed) res.destroy();
          });
          resolve({ kind: "relayed" });
        });
      });
      upstream.end(body);
    });
  }

  return { server, activeRequests: () => active };
}

function collectBounded(stream: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (size < max) chunks.push(chunk.subarray(0, max - size));
      size += chunk.length;
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
