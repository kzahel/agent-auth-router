import assert from "node:assert/strict";
import http from "node:http";
import { connect } from "node:net";
import { describe, test } from "node:test";
import { CredentialCoordinator } from "../src/coordinator.ts";
import { credentialReaderFor } from "../src/credentials.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import type { RenewalHelper } from "../src/helpers.ts";
import { createRouter } from "../src/server.ts";
import type { AccountConfig, GatewayClientRecord, Limits } from "../src/types.ts";
import { captureLogs, fakeJwt, listen, mockUpstream, tempDir, waitFor, writeClaudeCredentials, writeCodexAuth, type MockUpstream } from "./support.ts";

const CLAUDE_ACCESS = "SECRET-CLAUDE-ACCESS-1";
const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Harness {
  origin: string;
  token: string;
  clients: GatewayClientRecord[];
  claude: AccountConfig;
  codex: AccountConfig;
  coordinators: Map<string, CredentialCoordinator>;
  helperRuns: () => number;
  active: () => number;
}

async function harness(
  upstream: MockUpstream,
  options: { limits?: Partial<Limits>; claudeHelper?: RenewalHelper } = {},
): Promise<Harness> {
  const claude: AccountConfig = { id: "claude-a", provider: "claude", home: tempDir() };
  const codex: AccountConfig = { id: "codex-a", provider: "codex", home: tempDir() };
  writeClaudeCredentials(claude.home, CLAUDE_ACCESS, Date.now() + 3600_000);
  writeCodexAuth(codex.home, fakeJwt(nowSeconds() + 3600, "codex"), "acct-123");
  let runs = 0;
  const helper: RenewalHelper | undefined = options.claudeHelper
    ? async (context) => (runs++, options.claudeHelper!(context))
    : undefined;
  const coordinators = new Map<string, CredentialCoordinator>();
  for (const account of [claude, codex]) {
    coordinators.set(
      account.id,
      new CredentialCoordinator({
        account,
        read: credentialReaderFor(account.provider, account.home),
        helper: account === claude ? helper : undefined,
        helperContext: { workDir: tempDir() },
      }),
    );
  }
  const token = generateGatewayToken();
  const clients: GatewayClientRecord[] = [
    { id: "c1", name: "laptop", tokenSha256: hashGatewayToken(token), createdAt: "", accounts: { claude: "claude-a", codex: "codex-a" } },
  ];
  const router = createRouter({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      upstreams: { claude: upstream.origin, codex: upstream.origin },
      ...(options.limits ? { limits: options.limits } : {}),
    },
    clients: () => clients,
    coordinators,
  });
  const origin = await listen(router.server);
  return { origin, token, clients, claude, codex, coordinators, helperRuns: () => runs, active: router.activeRequests };
}

async function post(url: string, headers: Record<string, string>, body = "{}") {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe("router authentication and routing", () => {
  test("unauthenticated, revoked and unknown requests never reach the upstream", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);

    assert.equal((await post(`${h.origin}/claude/v1/messages`, {})).status, 401);
    assert.equal((await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${generateGatewayToken()}` })).status, 401);
    assert.equal((await post(`${h.origin}/claude/v1/complete`, { authorization: `Bearer ${h.token}` })).status, 404);
    assert.equal((await post(`${h.origin}/openai/v1/chat/completions`, { authorization: `Bearer ${h.token}` })).status, 404);
    assert.equal((await post(`${h.origin}/claude/v1/models`, { authorization: `Bearer ${h.token}` })).status, 405);
    assert.equal((await post(`${h.origin}/claude/v1/messages/../../admin`, { authorization: `Bearer ${h.token}` })).status, 404);

    h.clients[0]!.revokedAt = new Date().toISOString();
    const revoked = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` });
    assert.equal(revoked.status, 401);
    assert.equal(JSON.parse(revoked.text).error.type, "authentication_error");
    assert.equal(upstream.requests.length, 0);
  });

  test("a client cannot use a provider it was not granted", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);
    delete h.clients[0]!.accounts.codex;
    assert.equal((await post(`${h.origin}/codex/responses`, { authorization: `Bearer ${h.token}` })).status, 403);
    assert.equal(upstream.requests.length, 0);
  });

  test("absolute-form proxy targets are rejected", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);
    const { port } = new URL(h.origin);
    const raw = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(`POST http://evil.example/claude/v1/messages HTTP/1.1\r\nhost: evil.example\r\nauthorization: Bearer ${h.token}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`);
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
    });
    assert.match(raw, /^HTTP\/1.1 400/);
    assert.equal(upstream.requests.length, 0);
  });
});

describe("credential substitution", () => {
  test("claude: client auth is stripped and replaced with the account OAuth token and beta", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1", "request-id": "req_1" });
      res.end('{"ok":true}');
    });
    const h = await harness(upstream);
    const response = await post(
      `${h.origin}/claude/v1/messages?beta=true`,
      {
        "x-api-key": h.token,
        authorization: `Bearer ${h.token}`,
        cookie: "session=client",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
        "x-stainless-lang": "js",
        "x-forwarded-for": "10.0.0.1",
      },
      '{"model":"m"}',
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("request-id"), "req_1");

    const seen = upstream.requests[0]!;
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.headers.authorization, `Bearer ${CLAUDE_ACCESS}`);
    assert.equal(seen.headers["x-api-key"], undefined);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers["x-forwarded-for"], undefined);
    assert.equal(seen.headers["anthropic-beta"], "interleaved-thinking-2025-05-14,oauth-2025-04-20");
    assert.equal(seen.headers["x-stainless-lang"], "js");
    assert.equal(seen.body, '{"model":"m"}');
    assert.ok(!JSON.stringify(seen.headers).includes(h.token));
  });

  test("codex: responses route maps to the ChatGPT backend path with account id", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);
    const response = await post(`${h.origin}/codex/responses`, { authorization: `Bearer ${h.token}`, originator: "codex_cli_rs", session_id: "s1" });
    assert.equal(response.status, 200);
    const seen = upstream.requests[0]!;
    assert.equal(seen.url, "/backend-api/codex/responses");
    assert.match(String(seen.headers.authorization), /^Bearer eyJ/);
    assert.equal(seen.headers["chatgpt-account-id"], "acct-123");
    assert.equal(seen.headers.originator, "codex_cli_rs");
    assert.equal(seen.headers.session_id, "s1");
  });

  test("upstream redirects are refused and not followed", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => {
      res.writeHead(307, { location: "https://elsewhere.example/steal" });
      res.end();
    });
    const h = await harness(upstream);
    const response = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
    assert.equal(upstream.requests.length, 1);
  });

  test("oversized bodies are rejected before credential or upstream work", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream, { limits: { maxBodyBytes: 1024 } });
    const response = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` }, "x".repeat(4096));
    assert.equal(response.status, 413);
    assert.equal(upstream.requests.length, 0);
  });

  test("websocket upgrades are explicitly refused", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);
    const status = await new Promise<number | undefined>((resolve) => {
      const req = http.request(`${h.origin}/codex/responses`, {
        headers: { connection: "Upgrade", upgrade: "websocket", authorization: `Bearer ${h.token}` },
      });
      req.on("response", (res) => resolve(res.statusCode));
      req.on("upgrade", () => resolve(101));
      req.end();
    });
    assert.equal(status, 501);
    assert.equal(upstream.requests.length, 0);
  });
});

describe("streaming and cancellation", () => {
  test("SSE chunks are relayed before the upstream finishes", async () => {
    captureLogs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upstream = await mockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      gate.then(() => res.end("event: message_stop\ndata: {}\n\n"));
    });
    const h = await harness(upstream);
    const response = await fetch(`${h.origin}/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /message_start/);
    release();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    assert.match(rest, /message_stop/);
  });

  test("client disconnect tears down the upstream request", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      const timer = setInterval(() => res.write("data: tick\n\n"), 20);
      res.on("close", () => clearInterval(timer));
    });
    const h = await harness(upstream);
    const controller = new AbortController();
    const response = await fetch(`${h.origin}/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await waitFor(() => upstream.closedEarly === 1);
    await waitFor(() => h.active() === 0);
  });
});

describe("upstream authentication failures", () => {
  test("a 401 triggers one coordinated renewal and a single retry", async () => {
    captureLogs();
    const upstream = await mockUpstream((req, res) => {
      if (req.headers.authorization === `Bearer ${CLAUDE_ACCESS}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}');
        return;
      }
      res.end('{"ok":true}');
    });
    let h!: Harness;
    h = await harness(upstream, {
      claudeHelper: async () => {
        writeClaudeCredentials(h.claude.home, "SECRET-CLAUDE-ACCESS-2", Date.now() + 3600_000);
        return { outcome: "completed" };
      },
    });
    const response = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` }, '{"n":1}');
    assert.equal(response.status, 200);
    assert.equal(h.helperRuns(), 1);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1]!.headers.authorization, "Bearer SECRET-CLAUDE-ACCESS-2");
    assert.equal(upstream.requests[1]!.body, '{"n":1}');
  });

  test("a persistent 401 is relayed truthfully without a replay loop", async () => {
    const logs = captureLogs();
    const upstream = await mockUpstream((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid"}}');
    });
    let h!: Harness;
    let n = 0;
    h = await harness(upstream, {
      claudeHelper: async () => {
        writeClaudeCredentials(h.claude.home, `SECRET-CLAUDE-ACCESS-R${++n}`, Date.now() + 3600_000);
        return { outcome: "completed" };
      },
    });
    const response = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` });
    assert.equal(response.status, 401);
    assert.match(response.text, /authentication_error/);
    assert.equal(upstream.requests.length, 2);
    assert.equal(h.helperRuns(), 1);
    assert.equal(h.coordinators.get("claude-a")!.status().state, "login_required");
    assert.ok(!logs.join("\n").includes("SECRET-CLAUDE-ACCESS"));
    assert.ok(!logs.join("\n").includes(h.token));
  });

  test("an unavailable account returns 503 without contacting the upstream", async () => {
    captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end("{}"));
    const h = await harness(upstream);
    writeClaudeCredentials(h.claude.home, CLAUDE_ACCESS, Date.now() - 1000);
    const response = await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` });
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.text, new RegExp(h.claude.home.replace(/[/.]/g, "\\$&")));
    assert.equal(upstream.requests.length, 0);
  });

  test("request logs carry metadata only", async () => {
    const logs = captureLogs();
    const upstream = await mockUpstream((_req, res) => res.end('{"content":"SECRET-RESPONSE-BODY"}'));
    const h = await harness(upstream);
    await post(`${h.origin}/claude/v1/messages`, { authorization: `Bearer ${h.token}` }, '{"prompt":"SECRET-PROMPT"}');
    await waitFor(() => logs.some((line) => line.includes('"event":"request"')));
    const line = JSON.parse(logs.find((entry) => entry.includes('"event":"request"'))!);
    assert.equal(line.client, "laptop");
    assert.equal(line.account, "claude-a");
    assert.equal(line.upstreamStatus, 200);
    const all = logs.join("\n");
    for (const secret of ["SECRET-PROMPT", "SECRET-RESPONSE-BODY", CLAUDE_ACCESS, h.token]) assert.ok(!all.includes(secret), secret);
  });
});
