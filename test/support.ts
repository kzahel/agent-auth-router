import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { setLogSink } from "../src/log.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

export function tempDir(prefix = "aar-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Unsigned JWT-shaped fixture; the router only reads `exp`. */
export function fakeJwt(expSeconds: number, nonce: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expSeconds, nonce, sub: "synthetic" })}.c2lnbmF0dXJl`;
}

export function writeCodexAuth(home: string, accessToken: string, accountId = "acct-synthetic"): void {
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: "synthetic-id", access_token: accessToken, refresh_token: "SECRET-REFRESH-codex", account_id: accountId },
      last_refresh: new Date().toISOString(),
    }),
  );
}

export function writeClaudeCredentials(home: string, accessToken: string, expiresAt: number): void {
  writeFileSync(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "SECRET-REFRESH-claude", expiresAt, scopes: ["user:inference"] } }),
  );
}

export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockUpstream {
  origin: string;
  requests: RecordedRequest[];
  closedEarly: number;
}

export async function mockUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, recorded: RecordedRequest, upstream: MockUpstream) => void,
): Promise<MockUpstream> {
  const upstream: MockUpstream = { origin: "", requests: [], closedEarly: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      upstream.requests.push(recorded);
      res.on("close", () => {
        if (!res.writableFinished) upstream.closedEarly++;
      });
      handler(req, res, recorded, upstream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return upstream;
}

export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function captureLogs(): string[] {
  const lines: string[] = [];
  const previous = setLogSink((line) => lines.push(line));
  after(() => {
    setLogSink(previous);
  });
  return lines;
}

export function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("condition not met in time"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
