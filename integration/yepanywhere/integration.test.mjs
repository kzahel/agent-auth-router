import "./offline.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore, writePrivateJson } from "../../src/state.ts";

const checkout = resolve(import.meta.dirname, "../../artifacts/yepanywhere");
const pin = JSON.parse(
  readFileSync(new URL("./pin.json", import.meta.url), "utf8"),
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim(),
  pin.revision,
  "Run integration:prepare for the pinned YA revision",
);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim(),
  "",
  "YA fixture sources must be unmodified",
);
const requireYA = createRequire(join(checkout, "package.json"));
const tsx = pathToFileURL(requireYA.resolve("tsx")).href;
const cli = join(import.meta.dirname, "fake-cli.mjs");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const rows = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function eventually(predicate, message, milliseconds = 20_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${message}`);
}

async function fixture(t, provider) {
  const root = mkdtempSync("/tmp/aar-ya-");
  const home = join(root, "ya");
  const data = join(home, "data");
  const project = join(home, "project");
  for (const path of [
    home,
    data,
    project,
    join(home, "claude/projects"),
    join(home, "codex/sessions"),
    join(home, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const actors = [];
  const output = [];
  const apiBodies = [];
  const upstreamRequests = [];
  const credentials = [];
  let abandoned = 0;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    upstreamRequests.push({
      url: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      body,
    });
    if (request.url.includes("models")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "synthetic-model", display_name: "Synthetic" }],
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ text: "ROUTER:" })}\n\n`);
    if (JSON.parse(body).input === "hold") {
      response.once("close", () => {
        if (!response.writableFinished) abandoned++;
      });
      return;
    }
    response.end(
      `data: ${JSON.stringify({ text: JSON.parse(body).input })}\n\n`,
    );
  });
  t.after(async () => {
    try {
      const stopped = await Promise.allSettled(
        actors.map((child) => child.stop()),
      );
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      if (t.passed === false)
        t.diagnostic(
          (
            output.join("\n") +
            "\n" +
            JSON.stringify(rows(join(home, "native.jsonl"))) +
            "\n" +
            apiBodies.at(-1)
          ).replace(/aar_(?:ctl_)?[A-Za-z0-9_-]{43}/g, "[redacted]"),
        );
      for (const result of stopped)
        if (result.status === "rejected") throw result.reason;
      for (const credential of credentials)
        assert.equal(
          readFileSync(credential.path, "utf8"),
          credential.content,
          "Official credential fixtures must remain unchanged",
        );
      const privatePath = join(data, "agent-auth-router/private.json");
      const privateData = existsSync(privatePath) ? json(privatePath) : {};
      const secrets = [
        privateData.connection?.token,
        ...Object.values(privateData.allocations ?? {}).map((a) => a.token),
        ...credentials.map((c) => c.secret),
      ].filter(Boolean);
      const publicFiles = [
        join(data, "session-metadata.json"),
        join(root, "aar/control.json"),
        ...readdirSync(home, { recursive: true })
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(home, name)),
      ];
      const surfaces = [
        ...output,
        ...apiBodies,
        ...publicFiles
          .filter(existsSync)
          .map((path) => readFileSync(path, "utf8")),
      ];
      for (const secret of secrets)
        assert.ok(
          surfaces.every((text) => !text.includes(secret)),
          "Logs, transcripts, public responses and metadata exclude credentials",
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const store = new StateStore(join(root, "aar"));
  store.init();
  const accounts = ["selected", "other"].map((id) => {
    const accountHome = join(store.profilesDir, id);
    mkdirSync(accountHome, { mode: 0o700 });
    const secret = `synthetic-${provider}-${id}-access`;
    const path = join(
      accountHome,
      provider === "claude" ? ".credentials.json" : "auth.json",
    );
    writePrivateJson(
      path,
      provider === "claude"
        ? {
            claudeAiOauth: {
              accessToken: secret,
              refreshToken: "synthetic-refresh",
              expiresAt: Date.now() + 86_400_000,
            },
          }
        : {
            tokens: {
              access_token: secret,
              refresh_token: "synthetic-refresh",
              account_id: `synthetic-${id}`,
            },
          },
    );
    credentials.push({ path, content: readFileSync(path, "utf8"), secret });
    return { id, provider, home: accountHome };
  });
  store.saveAccounts(accounts);
  const config = {
    listen: { host: "127.0.0.1", port: 0 },
    upstreams: { claude: upstreamOrigin, codex: upstreamOrigin },
  };
  writePrivateJson(store.configPath, config);
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "share"),
    XDG_CACHE_HOME: join(home, "cache"),
    LANG: "en_US.UTF-8",
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    LOG_TO_FILE: "false",
    AAR_YA_CHECKOUT: checkout,
    AAR_STATE_DIR: store.dir,
    AAR_TEST_PROVIDER: provider,
    AAR_FAKE_CLI: cli,
    CLAUDE_CODE_EXECUTABLE: cli,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CLAUDE_SESSIONS_DIR: join(home, "claude/projects"),
    CODEX_HOME: join(home, "codex"),
    CODEX_SESSIONS_DIR: join(home, "codex/sessions"),
    YEP_DATA_DIR: data,
    YEP_PROVIDER_HOST_ENABLED: "false",
    VOICE_INPUT: "false",
    ENABLED_PROVIDERS: provider,
    // Poison ambient direct auth. Native routed adapters must override/remove it.
    ANTHROPIC_API_KEY: "synthetic-wrong-direct-key",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-wrong-direct-token",
    OPENAI_API_KEY: "synthetic-wrong-direct-key",
    CODEX_ACCESS_TOKEN: "synthetic-wrong-direct-token",
  };
  async function actor(file, loader = false) {
    const child = spawn(
      process.execPath,
      [
        ...(loader ? ["--import", tsx, "--conditions", "source"] : []),
        join(import.meta.dirname, file),
      ],
      {
        env,
        cwd: project,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let log = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        log = (log + chunk).slice(-262_144);
      });
    const exited = once(child, "exit");
    child.on("message", (message) => {
      if (message.event === "stop-router-for-failed-launch") {
        void router.stop().then(() => child.send({ event: "router-stopped" }));
      }
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await exited;
      output.push(log);
    };
    actors.push({ stop });
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      exited.then(([code]) => {
        throw new Error(`${file} exited ${code}: ${log}`);
      }),
      delay(30_000, undefined, { ref: false }).then(() => {
        throw new Error(`${file} startup timeout: ${log}`);
      }),
    ]);
    return { ...ready, stop, logs: () => log };
  }
  let router, ya;
  async function restartRouter() {
    await router?.stop();
    router = await actor("router-server.mjs");
    config.listen.port = Number(new URL(router.origin).port);
    writePrivateJson(store.configPath, config);
  }
  async function restartYA() {
    await ya?.stop();
    ya = await actor("ya-server.mjs", true);
  }
  async function api(path, body, allowedStatus = 200) {
    const response = await fetch(`${ya.origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-yep-anywhere": "true" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    apiBodies.push(JSON.stringify(value));
    if (allowedStatus !== null)
      assert.equal(
        response.status,
        allowedStatus,
        `${path}: ${JSON.stringify(value)}`,
      );
    return { status: response.status, value };
  }
  const privateState = () => json(join(data, "agent-auth-router/private.json"));
  const controlState = () => json(join(store.dir, "control.json"));
  await restartRouter();
  await restartYA();
  return {
    root,
    home,
    data,
    project,
    store,
    accounts,
    credentials,
    output,
    apiBodies,
    upstreamRequests,
    abandoned: () => abandoned,
    restartRouter,
    restartYA,
    api,
    privateState,
    controlState,
    router: () => router,
    ya: () => ya,
    launches: () => rows(join(home, "launches.jsonl")),
    native: () => rows(join(home, "native.jsonl")),
  };
}

for (const provider of ["codex", "claude"]) {
  test(`${provider}: real YA and AAR preserve the manual route lifecycle`, {
    timeout: 180_000,
  }, async (t) => {
    const f = await fixture(t, provider);
    const projectId = Buffer.from(f.project).toString("base64url");
    const startPath = `/projects/${projectId}/sessions`;
    const launch = (message, extra = {}) =>
      f.api(startPath, {
        provider,
        model: "synthetic-model",
        routerAccountId: "selected",
        message,
        sandboxLevel: "none",
        ...extra,
      });
    await f.api("/agent-auth-router/connect", {
      socketPath: f.router().socket,
    });
    assert.deepEqual(
      (await f.api("/agent-auth-router/accounts")).value.accounts.map(
        (a) => a.id,
      ),
      ["selected", "other"],
    );
    assert.equal(
      (await f.api("/agent-auth-router/accounts/selected/catalog")).value
        .models[0].id,
      "synthetic-model",
    );
    const created = (await launch("first")).value;
    t.diagnostic(`created ${provider}`);
    const idle = async () =>
      eventually(async () => {
        const { processes } = (await f.api("/processes")).value;
        return processes.find(
          (p) => p.id === created.processId && p.state === "idle",
        );
      }, `${provider} first turn completes`);
    const processInfo = await idle();
    const sessionId = processInfo.sessionId;
    assert.notEqual(
      sessionId,
      f.launches()[0].metadataId,
      "Native identity should replace the provisional ID",
    );
    const allocation = Object.values(f.privateState().allocations)[0];
    assert.equal(f.controlState().bindings[0].id, allocation.id);
    assert.equal(
      f.controlState().bindings[0].tokenHash,
      hash(allocation.token),
    );
    assert.equal(f.controlState().bindings[0].state, "committed");
    assert.equal(f.controlState().bindings[0].accountId, "selected");
    await f.api(`/sessions/${sessionId}/messages`, { message: "second" });
    await eventually(
      () =>
        f.upstreamRequests.filter((r) => r.body.includes('"input"')).length ===
        2,
      "continuation reaches AAR",
    );
    await idle();
    t.diagnostic(`continued ${provider}`);
    const detailPath = `/projects/${projectId}/sessions/${sessionId}`;
    assert.ok(
      JSON.stringify((await f.api(detailPath)).value).includes("ROUTER:second"),
      "YA reads the routed assistant response",
    );
    const metadata = json(join(f.data, "session-metadata.json"));
    assert.equal(metadata.sessions[sessionId].routerBinding.id, allocation.id);
    assert.equal(
      metadata.sessions[f.launches()[0].metadataId],
      undefined,
      "Provisional metadata is remapped",
    );
    await f.api(`/processes/${created.processId}/abort`, {});
    await f.router().stop();
    await f.restartYA();
    const beforeOutage = {
      launches: f.launches().length,
      requests: f.upstreamRequests.length,
    };
    assert.ok(
      (
        await f.api(
          `${detailPath}/resume`,
          { message: "offline", provider },
          null,
        )
      ).status >= 400,
    );
    assert.equal(
      f.launches().length,
      beforeOutage.launches,
      "Unavailable AAR must not fall back to direct auth",
    );
    assert.equal(f.upstreamRequests.length, beforeOutage.requests);
    await f.restartRouter();
    f.store.saveAccounts(
      f.accounts.map((a) => ({ ...a, enabled: a.id !== "selected" })),
    );
    assert.ok(
      (
        await f.api(
          `${detailPath}/resume`,
          { message: "disabled", provider },
          null,
        )
      ).status >= 400,
    );
    assert.equal(
      f.launches().length,
      beforeOutage.launches,
      "Disabled pin must not select another account",
    );
    assert.equal(f.upstreamRequests.length, beforeOutage.requests);
    f.store.saveAccounts(f.accounts);
    const resumed = (
      await f.api(`${detailPath}/resume`, { message: "third", provider })
    ).value;
    await eventually(
      () =>
        f.upstreamRequests.filter((r) => r.body.includes('"input"')).length ===
        3,
      "resume reaches AAR",
    );
    const idleProcess = (id) =>
      eventually(
        async () =>
          (await f.api("/processes")).value.processes.find(
            (p) => p.id === id && p.state === "idle",
          ),
        "resumed turn completes",
      );
    await idleProcess(resumed.processId);
    assert.equal(
      f.controlState().bindings.length,
      1,
      "Restart/resume cannot allocate a new pin",
    );
    assert.equal(f.controlState().bindings[0].id, allocation.id);
    assert.equal(f.launches().at(-1).resume, sessionId);
    assert.ok(
      f
        .native()
        .filter((r) => r.event === "spawn")
        .every((r) => r.tokenHash === hash(allocation.token)),
      "Native restart retains the inference credential",
    );
    assert.ok(
      JSON.stringify((await f.api(detailPath)).value).includes("ROUTER:third"),
    );
    t.diagnostic(`restarted and resumed ${provider}`);

    // An unfinished upstream response must stream before completion and close
    // when YA interrupts the turn. The committed account pin remains usable.
    const deltas = f.native().filter((r) => r.event === "delta").length;
    await f.api(`/sessions/${sessionId}/messages`, { message: "hold" });
    await eventually(
      () => f.native().filter((r) => r.event === "delta").length > deltas,
      "partial response reaches native adapter before upstream finishes",
    );
    await f.api(`/processes/${resumed.processId}/interrupt`, {});
    await eventually(
      () => f.abandoned() === 1,
      "cancelled stream closes upstream",
    );
    await idleProcess(resumed.processId);
    assert.equal(f.controlState().bindings[0].state, "committed");
    await f.api(`/sessions/${sessionId}/messages`, { message: "after-cancel" });
    await eventually(
      () => f.upstreamRequests.some((r) => r.body.includes('"after-cancel"')),
      "next turn reuses the pin",
    );
    await idleProcess(resumed.processId);

    // A launch failure after allocation must durably revoke its separate token.
    writeFileSync(join(f.home, "fail-next-launch"), "synthetic");
    const failed = await f.api(
      startPath,
      {
        provider,
        model: "synthetic-model",
        routerAccountId: "selected",
        message: "fail",
      },
      null,
    );
    assert.ok(failed.status >= 400, "Injected native failure is reported");
    const cancelled = f
      .controlState()
      .bindings.find((b) => b.id !== allocation.id);
    assert.equal(cancelled.state, "cancelled");
    const privateCancelled = f.privateState().allocations[cancelled.id];
    assert.equal(privateCancelled.cancelled, true);
    assert.equal(privateCancelled.cancellationAcknowledged, true);
    const infer = (token) =>
      fetch(
        `${f.router().origin}/${provider}${provider === "claude" ? "/v1/messages" : "/responses"}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        },
      );
    assert.equal((await infer(privateCancelled.token)).status, 401);

    const count = f.upstreamRequests.length;
    await f.api("/agent-auth-router/disconnect", {});
    assert.equal((await infer(allocation.token)).status, 401);
    await f.api(`/sessions/${sessionId}/messages`, {
      message: "revoked-worker",
    });
    await eventually(
      () => f.native().some((r) => r.event === "inference" && r.status === 401),
      "already-running native worker loses inference access",
    );
    await idleProcess(resumed.processId);
    assert.equal(
      f.upstreamRequests.length,
      count,
      "Revocation never reaches an upstream account",
    );
    await f.api(`/processes/${resumed.processId}/abort`, {});
    await f.restartRouter();
    await f.restartYA();
    assert.equal(
      (await infer(allocation.token)).status,
      401,
      "Revocation survives restart",
    );
    const launches = f.launches().length;
    const refused = await f.api(
      `${detailPath}/resume`,
      { message: "no-fallback", provider },
      null,
    );
    assert.ok(refused.status >= 400);
    assert.equal(
      f.launches().length,
      launches,
      "Revoked session cannot start a direct provider",
    );
    assert.equal(f.upstreamRequests.length, count);
    for (const request of f.upstreamRequests) {
      assert.equal(
        request.authorization,
        `Bearer ${f.credentials[0].secret}`,
        "Only the pinned provider credential reaches upstream",
      );
      if (provider === "codex")
        assert.equal(request.account, "synthetic-selected");
    }
    assert.equal(
      statSync(join(f.data, "agent-auth-router/private.json")).mode & 0o777,
      0o600,
    );
    assert.equal(
      statSync(join(f.data, "agent-auth-router")).mode & 0o777,
      0o700,
    );
    assert.equal(existsSync(join(f.home, "codex/auth.json")), false);
    assert.equal(existsSync(join(f.home, "claude/.credentials.json")), false);
  });

  test(`${provider}: pending disconnect survives YA restart and revokes the old pin`, {
    timeout: 90_000,
  }, async (t) => {
    const f = await fixture(t, provider);
    const projectId = Buffer.from(f.project).toString("base64url");
    await f.api("/agent-auth-router/connect", {
      socketPath: f.router().socket,
    });
    const created = (
      await f.api(`/projects/${projectId}/sessions`, {
        provider,
        model: "synthetic-model",
        routerAccountId: "selected",
        message: "before-outage",
        sandboxLevel: "none",
      })
    ).value;
    const info = await eventually(
      async () =>
        (await f.api("/processes")).value.processes.find(
          (p) => p.id === created.processId && p.state === "idle",
        ),
      "first turn completes",
    );
    const allocation = Object.values(f.privateState().allocations)[0];
    await f.api(`/processes/${created.processId}/abort`, {});
    await f.router().stop();
    assert.equal(
      (await f.api("/agent-auth-router/disconnect", {}, null)).status,
      409,
    );
    assert.equal(f.privateState().connection.state, "revocation-pending");
    await f.restartYA();
    assert.equal(
      (await f.api("/agent-auth-router")).value.state,
      "revocation-pending",
    );
    await f.restartRouter();
    const launches = f.launches().length,
      requests = f.upstreamRequests.length;
    assert.equal(
      (
        await f.api(
          "/agent-auth-router/connect",
          { socketPath: f.router().socket },
          null,
        )
      ).status,
      409,
      "Pending revocation cannot be replaced by a new pairing",
    );
    assert.ok(
      (
        await f.api(
          `/projects/${projectId}/sessions/${info.sessionId}/resume`,
          { provider, message: "no-fallback" },
          null,
        )
      ).status >= 400,
    );
    assert.equal(f.launches().length, launches);
    assert.equal(f.upstreamRequests.length, requests);
    await f.api("/agent-auth-router/disconnect", {});
    assert.equal(f.privateState().connection.state, "disconnected");
    const response = await fetch(
      `${f.router().origin}/${provider}${provider === "claude" ? "/v1/messages" : "/responses"}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${allocation.token}` },
        body: "{}",
      },
    );
    assert.equal(response.status, 401);
    await response.body.cancel();
    assert.equal(f.upstreamRequests.length, requests);
    await f.api("/agent-auth-router/connect", {
      socketPath: f.router().socket,
    });
    assert.ok(
      (
        await f.api(
          `/projects/${projectId}/sessions/${info.sessionId}/resume`,
          { provider, message: "different-pairing" },
          null,
        )
      ).status >= 400,
    );
    assert.equal(
      f.launches().length,
      launches,
      "A new pairing cannot adopt an old session's account pin",
    );
  });

  test(`${provider}: failed-launch cancellation retries durably after control recovers`, {
    timeout: 90_000,
  }, async (t) => {
    const f = await fixture(t, provider);
    const startPath = `/projects/${Buffer.from(f.project).toString("base64url")}/sessions`;
    const body = {
      provider,
      model: "synthetic-model",
      routerAccountId: "selected",
      message: "fixture",
      sandboxLevel: "none",
    };
    await f.api("/agent-auth-router/connect", {
      socketPath: f.router().socket,
    });
    writeFileSync(join(f.home, "fail-next-launch"), "offline");
    assert.ok((await f.api(startPath, body, null)).status >= 400);
    const allocation = Object.values(f.privateState().allocations)[0];
    assert.equal(allocation.cancelled, true);
    assert.notEqual(allocation.cancellationAcknowledged, true);
    assert.equal(
      f.controlState().bindings[0].state,
      "committed",
      "No claim of revocation while AAR is unreachable",
    );
    assert.equal(
      f.native().length,
      0,
      "Injected launch failure precedes native startup",
    );
    await f.restartRouter();
    await f.restartYA();
    // Cancellation must remain possible even if the account has since been disabled.
    f.store.saveAccounts(
      f.accounts.map((a) => ({ ...a, enabled: a.id !== "selected" })),
    );
    assert.ok((await f.api(startPath, body, null)).status >= 400);
    assert.equal(
      f.privateState().allocations[allocation.id].cancellationAcknowledged,
      true,
    );
    assert.equal(
      f.controlState().bindings.find((b) => b.id === allocation.id).state,
      "cancelled",
    );
    assert.equal(f.native().length, 0);
    const response = await fetch(
      `${f.router().origin}/${provider}${provider === "claude" ? "/v1/messages" : "/responses"}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${allocation.token}` },
        body: "{}",
      },
    );
    assert.equal(response.status, 401);
    await response.body.cancel();
    f.store.saveAccounts(f.accounts);
    const created = (await f.api(startPath, body)).value;
    await eventually(
      async () =>
        (await f.api("/processes")).value.processes.find(
          (p) => p.id === created.processId && p.state === "idle",
        ),
      "new launch succeeds after reconciliation",
    );
    assert.equal(
      f.controlState().bindings.filter((b) => b.state === "committed").length,
      1,
    );
    assert.equal(
      f.upstreamRequests.filter((r) => r.body.includes('"input"')).length,
      1,
      "Only the recovered new launch reaches inference",
    );
  });
}
