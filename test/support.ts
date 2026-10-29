import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { setLogSink } from "../src/log.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

// Root-level cleanup runs after test-scoped router/socket teardown. Registering
// deletion inside tempDir made its earlier hook delete state before close().
const temporaryDirectories: string[] = [];
after(() => { for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true }); });
export function tempDir(prefix = "aar-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/**
 * A synthetic UI build shaped like `vite build` output in ui/dist: the
 * management page, a terminal page, hashed assets and the manifest.
 */
export function uiBuild(): string {
  const dir = tempDir("aar-ui-");
  const files: Record<string, string> = {
    "index.html": '<!doctype html><script type="module" src="./assets/index-a1.js"></script>',
    "terminal.html": '<!doctype html><script type="module" src="./assets/terminal-b2.js"></script>',
    "assets/index-a1.js": 'import "./shared-c3.js";',
    "assets/shared-c3.js": "export {};",
    "assets/shared-d4.css": ":root {}",
    "assets/terminal-b2.js": 'import "./shared-c3.js";',
    "assets/terminal-e5.css": "#terminal {}",
    "third-party-licenses.txt": "synthetic",
    ".vite/manifest.json": JSON.stringify({
      "index.html": { file: "assets/index-a1.js", src: "index.html", isEntry: true, imports: ["_shared-c3.js"] },
      "terminal.html": { file: "assets/terminal-b2.js", src: "terminal.html", isEntry: true, imports: ["_shared-c3.js"], css: ["assets/terminal-e5.css"] },
      "_shared-c3.js": { file: "assets/shared-c3.js", css: ["assets/shared-d4.css"] },
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
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
  /** The body's bytes, for encodings text would corrupt. */
  raw: Buffer;
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
      const raw = Buffer.concat(chunks);
      const recorded = { method: req.method, url: req.url, headers: req.headers, body: raw.toString(), raw };
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
