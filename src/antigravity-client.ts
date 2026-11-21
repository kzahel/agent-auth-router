import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ADAPTERS, parseUpstreamOrigin, relayableResponseHeaders } from "./providers.ts";
import { DEFAULT_LIMITS } from "./types.ts";

const MARKER = /^aar_local_[A-Za-z0-9_-]{43}$/;

async function privateEntry(path: string, kind: "file" | "directory"): Promise<void> {
  const stat = await lstat(path);
  if (!(kind === "file" ? stat.isFile() : stat.isDirectory()) || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error(`Antigravity bridge requires an owner-only ${kind}`);
  }
}

async function writeOnce(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await privateEntry(path, "file");
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function bridgeProfile(home: string): Promise<string> {
  const directory = join(home, "antigravity-cli");
  for (const path of [home, directory]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await privateEntry(path, "directory");
  }
  const settings = join(directory, "settings.json");
  const credential = join(directory, "antigravity-oauth-token");
  if ((await entryExists(settings)) && !(await entryExists(credential))) {
    throw new Error("Choose a new Antigravity bridge profile");
  }
  // agy can present this marker to Google UserInfo. It is only accepted on this
  // loopback listener. AAR's real token stays in the bridge process.
  await writeOnce(credential, {
    auth_method: "consumer",
    token: { access_token: `aar_local_${randomBytes(32).toString("base64url")}`, token_type: "Bearer", expiry: "9999-12-31T23:59:59Z" },
  });
  const cached = JSON.parse(await readFile(credential, "utf8"));
  if (cached?.auth_method !== "consumer" || !MARKER.test(cached.token?.access_token) || cached.token?.refresh_token) {
    throw new Error("Choose a dedicated Antigravity bridge profile without a Google login");
  }
  await writeOnce(settings, { auth: { type: "oauth-personal" } });
  const config = JSON.parse(await readFile(settings, "utf8"));
  if (config?.auth?.type !== "oauth-personal" || config.modelProvider) {
    throw new Error("Choose a dedicated Antigravity bridge profile");
  }
  return cached.token.access_token;
}

export async function startAntigravityBridge(options: { gateway: string; home: string; tokenFile: string; port?: number }) {
  const gateway = parseUpstreamOrigin(options.gateway);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid bridge port");
  await privateEntry(options.tokenFile, "file");
  const token = (await readFile(options.tokenFile, "utf8")).trim();
  if (!/^aar_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Antigravity bridge requires an AAR client token");
  const marker = await bridgeProfile(options.home);
  const limits = DEFAULT_LIMITS;
  const adapter = ADAPTERS.antigravity;
  const transport = gateway.protocol === "https:" ? https : http;
  let host: string;
  const server = http.createServer({ maxHeaderSize: limits.maxHeaderBytes, requestTimeout: limits.clientRequestTimeoutMs }, (req, res) => {
    const target = req.url ?? "";
    const path = target.split("?", 1)[0];
    const route = adapter.routes.find((route) => route.path === path && route.method === req.method);
    const reject = (status: number) => {
      req.resume();
      if (res.headersSent) res.destroy();
      else { res.writeHead(status); res.end(); }
    };
    if (req.headers.host !== host || req.headers.authorization !== `Bearer ${marker}`) return reject(401);
    if (!route) return reject(404);
    const headers: http.OutgoingHttpHeaders = { authorization: `Bearer ${token}` };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && (adapter.forwardHeader(name) || name === "content-length")) headers[name] = value;
    }
    const upstream = transport.request(new URL(`/antigravity${target}`, gateway), { method: route.method, headers }, (response) => {
      clearTimeout(headerDeadline);
      upstream.setTimeout(limits.streamIdleTimeoutMs, () => upstream.destroy());
      res.writeHead(response.statusCode ?? 502, relayableResponseHeaders(response.headers));
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    const headerDeadline = setTimeout(() => upstream.destroy(), limits.upstreamHeadersTimeoutMs);
    upstream.once("close", () => clearTimeout(headerDeadline));
    upstream.on("error", () => reject(502));
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  return {
    endpoint: `http://${host}`,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
