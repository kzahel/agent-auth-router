import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ControlRegistry } from "../src/control.ts";
import { hashGatewayToken, generateGatewayToken } from "../src/gateway-auth.ts";
import { ownerRequest } from "../src/owner.ts";
import { PoolEvidence } from "../src/pools.ts";
import { startRouter } from "../src/runtime.ts";
import { StateStore, writePrivateJson } from "../src/state.ts";
import { mockUpstream, tempDir, writeClaudeCredentials } from "./support.ts";

const token = (n: number) => `aar_ctl_${Buffer.alloc(32, n).toString("base64url")}`;
function request(
  store: StateStore,
  path: string,
  credential: string,
  body: object,
): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: join(store.dir, "control.sock"),
        path,
        method: "POST",
        headers: { host: "localhost", authorization: `Bearer ${credential}` },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, value: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function fixture() {
  const store = new StateStore(tempDir("owner-"));
  store.init();
  store.saveAccounts(
    ["a", "b"].map((id) => ({ id, provider: "claude", home: join(store.profilesDir, id) })),
  );
  const registry = new ControlRegistry(store);
  for (const n of [1, 2])
    registry.pair({ id: randomUUID(), name: `Client ${n}`, tokenHash: hashGatewayToken(token(n)) });
  const first = registry.authenticate(`Bearer ${token(1)}`),
    second = registry.authenticate(`Bearer ${token(2)}`);
  const pool = {
    id: randomUUID(),
    name: "Work",
    provider: "claude",
    policy: "round-robin",
    accountIds: ["a", "b"],
    revision: 0,
  };
  registry.savePool(pool);
  const evidence = new PoolEvidence(
    async () => [{ id: "fixture", name: "Fixture" }],
    async (accountId) => ({
      accountId,
      provider: "claude",
      status: "ok",
      observedAt: new Date().toISOString(),
      windows: [
        {
          bucket: "five_hour",
          windowMinutes: 300,
          remainingPercent: 80,
          usedPercent: 20,
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    }),
  );
  const allocation = () => ({
    id: randomUUID(),
    poolId: pool.id,
    provider: "claude",
    model: "fixture",
    tokenHash: hashGatewayToken(generateGatewayToken()),
  });
  return { store, registry, first, second, pool, evidence, allocation };
}

test("owner grants follow shared pool membership, arbitrate across clients and survive disconnect", async () => {
  const f = fixture();
  assert.deepEqual(f.registry.accounts(f.first), []);
  assert.throws(() => f.registry.pool(f.first, f.pool.id), /not found/);
  for (const i of [f.first, f.second])
    f.registry.grant({ id: i.id, revision: 1, poolIds: [f.pool.id] });
  await Promise.all([f.evidence.refresh("a"), f.evidence.refresh("b")]);
  const one = f.allocation(),
    two = f.allocation();
  assert.equal((f.registry.preparePool(f.first, one, f.evidence) as any).accountId, "a");
  assert.equal((f.registry.preparePool(f.second, two, f.evidence) as any).accountId, "b");
  assert.throws(
    () => f.registry.prepare(f.first, { ...f.allocation(), accountId: "a" }),
    /direct account access/,
  );
  f.registry.transition(f.first, one.id, "commit", f.evidence);
  f.registry.transition(f.second, two.id, "commit", f.evidence);
  f.registry.grant({ id: f.first.id, revision: 2, poolIds: [] });
  assert.equal(f.registry.clients().length, 1);
  assert.throws(
    () => f.registry.pool(f.first, f.pool.id),
    /not found/,
    "stale references cannot retain grants",
  );
  f.registry.revoke(f.second);
  assert.equal(f.registry.clients().length, 0);
  assert.equal(f.registry.pools().length, 1, "router pool outlives both consumers");
});

test("v2 migration preserves identity, cursor, pins, cancellation and grants without widening", async () => {
  const f = fixture();
  f.registry.grant({ id: f.first.id, revision: 1, poolIds: [f.pool.id], accountIds: ["a", "b"] });
  await f.evidence.refresh("a");
  const allocation = f.allocation();
  f.registry.preparePool(f.first, allocation, f.evidence);
  f.registry.transition(f.first, allocation.id, "commit", f.evidence);
  f.registry.transition(f.first, randomUUID(), "cancel");
  f.registry.revoke(f.second);
  const path = join(f.store.dir, "control.json"),
    old = JSON.parse(readFileSync(path, "utf8"));
  old.version = 2;
  old.pools[0].integrationId = f.first.id;
  for (const i of old.integrations) {
    delete i.poolIds;
    delete i.revision;
  }
  writeFileSync(path, JSON.stringify(old));
  const migrated = new ControlRegistry(f.store),
    next = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(next.version, 3);
  assert.equal(next.routerId, old.routerId);
  assert.deepEqual(next.bindings, old.bindings);
  assert.deepEqual(next.cancellations, old.cancellations);
  assert.deepEqual(next.pools[0], { ...f.pool, revision: 1, cursor: "a" });
  assert.deepEqual(
    migrated.accounts(migrated.authenticate(`Bearer ${token(1)}`)).map((a) => a.id),
    ["a", "b"],
  );
  assert.throws(() => migrated.authenticate(`Bearer ${token(2)}`), /revoked/);
  assert.equal(migrated.clients()[0]?.id, allocation.id);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.pre-v3`, "utf8")), old);
  new ControlRegistry(f.store);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), next, "migration is idempotent");
});

test("late evidence is discarded when an account changes", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const evidence = new PoolEvidence(
    async () => {
      await wait;
      return [{ id: "old", name: "Old" }];
    },
    async (accountId) => {
      await wait;
      return {
        accountId,
        provider: "claude",
        status: "ok",
        observedAt: new Date().toISOString(),
        windows: [],
      };
    },
  );
  const pending = evidence.refresh("a");
  evidence.invalidate("a");
  release();
  await pending;
  assert.equal(evidence.get("a").quota, null);
  assert.deepEqual(evidence.get("a").models, []);
});

test("private owner enrollment and grants take effect without restart or re-pair; busy stop refuses", {
  skip: process.platform === "win32",
}, async (t) => {
  const store = new StateStore(tempDir("own-http-"));
  store.init();
  let finish: (() => void) | undefined;
  const upstream = await mockUpstream((_req, res, recorded) => {
    if (recorded.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: start\n\n");
      finish = () => res.end("data: done\n\n");
    }
  });
  writePrivateJson(store.configPath, {
    listen: { host: "127.0.0.1", port: 0 },
    upstreams: { claude: upstream.origin },
  });
  const router = await startRouter(store);
  t.after(() => router.close());
  const id = randomUUID();
  await request(store, "/v1/pair", token(1), {
    id,
    name: "YA",
    tokenHash: hashGatewayToken(token(1)),
  });
  assert.equal(
    (await request(store, "/v1/owner/accounts/add", token(1), { id: "a", provider: "claude" }))
      .status,
    401,
  );
  await ownerRequest(store, "accounts/add", { id: "a", provider: "claude" });
  writeClaudeCredentials(join(store.profilesDir, "a"), "synthetic", Date.now() + 3600000);
  assert.equal(router.coordinators.has("a"), true);
  assert.equal((await request(store, "/v1/catalog", token(1), { accountId: "a" })).status, 403);
  const pool = {
    id: randomUUID(),
    name: "Work",
    provider: "claude",
    policy: "manual",
    accountIds: ["a"],
    revision: 0,
  };
  await ownerRequest(store, "pools/save", pool);
  await ownerRequest(store, "grants/save", { id, revision: 1, poolIds: [pool.id] });
  const gateway = generateGatewayToken(),
    allocation = {
      id: randomUUID(),
      poolId: pool.id,
      accountId: "a",
      provider: "claude",
      model: "fixture",
      tokenHash: hashGatewayToken(gateway),
    };
  assert.equal((await request(store, "/v1/pools/prepare", token(1), allocation)).status, 200);
  assert.equal(
    (await request(store, "/v1/bindings/commit", token(1), { id: allocation.id })).status,
    200,
  );
  const response = await fetch(`${router.origin}/claude/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${gateway}` },
    body: "{}",
  });
  const overview = await ownerRequest(store, "overview");
  await assert.rejects(ownerRequest(store, "stop", { routerId: overview.routerId }), /busy/);
  await assert.rejects(ownerRequest(store, "accounts/remove", { id: "a", revision: 1 }), /busy/);
  await ownerRequest(store, "accounts/add", { id: "b", provider: "claude" });
  await ownerRequest(store, "accounts/set-enabled", { id: "a", revision: 1, enabled: false });
  assert.equal(
    (
      await fetch(`${router.origin}/claude/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${gateway}` },
        body: "{}",
      })
    ).status,
    401,
  );
  finish!();
  assert.match(
    await response.text(),
    /done/,
    "accepted stream survives enrollment and disablement",
  );
  assert.doesNotMatch(
    JSON.stringify(await ownerRequest(store, "overview")),
    /synthetic|tokenHash|owner_/,
  );
});

test("versioned account and client registries prevent legacy array writers from reopening state", () => {
  const store = new StateStore(tempDir("owner-migrate-"));
  store.init();
  const accounts = [{ id: "a", provider: "claude", home: join(store.profilesDir, "a") }];
  writePrivateJson(store.accountsPath, accounts);
  writePrivateJson(store.clientsPath, []);
  new ControlRegistry(store);
  assert.deepEqual(store.loadAccounts(), accounts);
  assert.deepEqual(store.loadClients(), []);
  for (const path of [store.accountsPath, store.clientsPath]) {
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3);
    assert.ok(Array.isArray(JSON.parse(readFileSync(`${path}.pre-v3`, "utf8"))));
    assert.throws(() => [...JSON.parse(readFileSync(path, "utf8"))], /not iterable/);
  }
});

test("retiring an enrollment keeps credentials, blocks admission and prevents identity reuse", {
  skip: process.platform === "win32",
}, async (t) => {
  const store = new StateStore(tempDir("retire-"));
  store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const router = await startRouter(store);
  t.after(() => router.close());
  await ownerRequest(store, "accounts/add", { id: "work", provider: "claude" });
  const home = store.loadAccounts()[0]!.home;
  writeClaudeCredentials(home, "synthetic", Date.now() + 3600000);
  const credential = readFileSync(join(home, ".credentials.json"), "utf8");
  await ownerRequest(store, "accounts/retire", { id: "work", revision: 1 });
  assert.equal(store.loadAccounts()[0]!.enabled, false);
  assert.equal(store.loadAccounts()[0]!.retired, true);
  await assert.rejects(
    ownerRequest(store, "accounts/add", { id: "work", provider: "claude" }),
    /already enrolled/,
  );
  await assert.rejects(
    ownerRequest(store, "accounts/set-enabled", { id: "work", revision: 2, enabled: true }),
    /retired/,
  );
  assert.equal(readFileSync(join(home, ".credentials.json"), "utf8"), credential);
});

test("official login is isolated, bounded, cancellable and never projects raw output", {
  skip: process.platform === "win32",
}, async (t) => {
  const store = new StateStore(tempDir("login-"));
  store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const bin = join(store.dir, "bin");
  mkdirSync(bin);
  const script = join(bin, "claude");
  writeFileSync(
    script,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.CLAUDE_CONFIG_DIR+'/login-probe.json',JSON.stringify({pid:process.pid,argv:process.argv.slice(2),gateway:process.env.ANTHROPIC_AUTH_TOKEN??null,base:process.env.ANTHROPIC_BASE_URL??null}));\nprocess.on('SIGTERM',()=>{});\nprocess.stdout.write('raw-sensitive-output https://attacker.invalid/oauth/authorize?access_token=never-show\\n');\nprocess.stderr.write('https://claude.ai/oauth/authorize?state=synthetic&code_challenge=fixture\\n');\nsetInterval(()=>{},1000);\n`,
  );
  chmodSync(script, 0o700);
  const before = {
    PATH: process.env.PATH,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    ANTHROPIC_AUTH_TOKEN: "forbidden-gateway",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const router = await startRouter(store);
  t.after(() => router.close());
  await ownerRequest(store, "accounts/add", { id: "work", provider: "claude" });
  await ownerRequest(store, "accounts/login", { id: "work" });
  await assert.rejects(router.coordinators.get("work")!.credential(), /login in progress/);
  let status: any;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    status = await ownerRequest(store, "accounts/login-status", { id: "work" });
    if (status.canOpenLogin) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status.canOpenLogin, true);
  const probe = JSON.parse(readFileSync(join(store.profilesDir, "work/login-probe.json"), "utf8"));
  assert.deepEqual({ ...probe, pid: undefined }, { pid: undefined, argv: ["auth", "login", "--claudeai"], gateway: null, base: null });
  const overview = await ownerRequest(store, "overview");
  assert.doesNotMatch(
    JSON.stringify({ overview, status }),
    /raw-sensitive-output|attacker|code_challenge|forbidden-gateway|never-show/,
  );
  await assert.rejects(ownerRequest(store, "stop", { routerId: overview.routerId }), /busy/);
  await assert.rejects(ownerRequest(store, "accounts/remove", { id: "work", revision: 1, deleteProfile: true }), /busy/);
  await ownerRequest(store, "accounts/cancel-login", { id: "work" });
  await assert.rejects(ownerRequest(store, "accounts/remove", { id: "work", revision: 1 }), /busy/, "cancelled sign-in still owns its profile until the process exits");
  assert.equal(
    (await ownerRequest(store, "accounts/login-status", { id: "work" })).loginStatus,
    "cancelled",
  );
  assert.equal((await ownerRequest(store, "accounts/login-status", { id: "work" })).canOpenLogin, false);
  await ownerRequest(store, "accounts/add", { id: "closing", provider: "claude" });
  await ownerRequest(store, "accounts/login", { id: "closing" });
  let closingPid: number | undefined;
  const closingDeadline = Date.now() + 5000;
  while (Date.now() < closingDeadline) {
    try { closingPid = JSON.parse(readFileSync(join(store.profilesDir, "closing/login-probe.json"), "utf8")).pid; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(closingPid);
  const stopped = router.close();
  await assert.rejects(ownerRequest(store, "accounts/login", { id: "work" }), /unavailable|stopping|connect|socket|EPIPE/i);
  await stopped;
  assert.throws(() => process.kill(closingPid!, 0), { code: "ESRCH" }, "shutdown reaps the official login");
  await router.close();
});

test("owner profile metadata, optional nicknames and expiry preserve identity and integration privacy", async t => {
  const store = new StateStore(tempDir("owner-profile-"));
  store.init(); writeFileSync(join(store.dir, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }), { mode: 0o600 });
  const router = await startRouter(store); t.after(() => router.close());
  const added = await ownerRequest(store, "accounts/add", { provider: "claude", nickname: "  Work  " });
  assert.match(added.id, /^[a-z0-9-]+$/);
  const original = store.loadAccounts()[0]!;
  writeClaudeCredentials(original.home, "expired-fixture", Date.now() - 1000);
  const status = await ownerRequest(store, "accounts/login-status", { id: added.id });
  assert.equal(status.signIn, "idle", "an expired access token with a refresh token renews on next use");
  assert.doesNotMatch(JSON.stringify(status), /expired-fixture|SECRET-REFRESH/);
  const overview = await ownerRequest(store, "overview");
  assert.equal(overview.accounts[0].home, original.home);
  assert.equal(overview.accounts[0].nickname, "Work");
  await ownerRequest(store, "accounts/set-nickname", { id: added.id, revision: 1, nickname: "Personal" });
  await assert.rejects(ownerRequest(store, "accounts/set-nickname", { id: added.id, revision: 1, nickname: "stale" }), /changed/);
  await assert.rejects(ownerRequest(store, "accounts/set-nickname", { id: added.id, revision: 2, nickname: "bad\nname" }), /nickname/);
  await ownerRequest(store, "accounts/set-nickname", { id: added.id, revision: 2, nickname: "" });
  const current = store.loadAccounts()[0]!;
  assert.equal(current.id, original.id); assert.equal(current.home, original.home);
  assert.equal(current.nickname, undefined);
  await assert.rejects(ownerRequest(store, "accounts/add", { provider: "claude", home: "relative" }), /absolute/);
  const f = fixture();
  f.registry.grant({ id: f.first.id, revision: 1, poolIds: [f.pool.id] });
  const client = f.registry.accounts(f.first)[0]!;
  assert.equal("home" in client, false); assert.equal("nickname" in client, false);
});


test("removal hides retired accounts, cleans grants and pools, and never revives old pins", async t => {
  const f = fixture(), { store } = f;
  mkdirSync(join(store.profilesDir, "a"));
  writeClaudeCredentials(join(store.profilesDir, "a"), "synthetic-removal", Date.now() + 3600000);
  const original = readFileSync(join(store.profilesDir, "a/.credentials.json"), "utf8");
  f.registry.grant({ id: f.first.id, revision: 1, poolIds: [f.pool.id], accountIds: ["a"] });
  await f.evidence.refresh("a");
  const allocation = { ...f.allocation(), policy: "manual", accountId: "a" };
  f.registry.preparePool(f.first, allocation, f.evidence);
  f.registry.transition(f.first, allocation.id, "commit", f.evidence);
  const legacy = generateGatewayToken();
  store.saveClients([{ id: "legacy", name: "Legacy", tokenSha256: hashGatewayToken(legacy), createdAt: new Date().toISOString(), accounts: { claude: "a" } }]);
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  let router = await startRouter(store); t.after(() => router.close());
  for (const operation of ["accounts/removal-preview", "accounts/remove"]) {
    assert.equal((await request(store, `/v1/owner/${operation}`, token(1), { id: "a", revision: 0 })).status, 401);
  }
  await ownerRequest(store, "accounts/retire", { id: "a", revision: 0 });
  await assert.rejects(ownerRequest(store, "accounts/remove", { id: "a", revision: 0 }), /changed/);
  await ownerRequest(store, "accounts/remove", { id: "a", revision: 1 });
  const overview = await ownerRequest(store, "overview");
  assert.deepEqual(overview.accounts.map((a: any) => a.id), ["b"]);
  assert.deepEqual(overview.pools[0].accountIds, ["b"]);
  assert.equal(overview.pools[0].revision, 2);
  assert.deepEqual(overview.integrations[0].accountIds, []);
  assert.equal(overview.integrations[0].revision, 3);
  assert.equal(readFileSync(join(store.profilesDir, "a/.credentials.json"), "utf8"), original);
  assert.equal(router.coordinators.has("a"), false);
  await ownerRequest(store, "accounts/add", { id: "replacement", provider: "claude", enrollment: "existing", home: join(store.profilesDir, "a"), credentialStore: "file" });
  await assert.rejects(ownerRequest(store, "accounts/add", { id: "a", provider: "claude" }), /identity was removed/);
  const registry = new ControlRegistry(store);
  assert.equal(registry.clients().length, 0);
  assert.throws(() => registry.transition(registry.authenticate(`Bearer ${token(1)}`), allocation.id, "commit", f.evidence), /removed|grant/);
  const useLegacy = () => fetch(`${router.origin}/claude/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${legacy}` }, body: "{}" });
  assert.ok((await useLegacy()).status >= 400);
  await router.close(); router = await startRouter(store);
  assert.ok((await useLegacy()).status >= 400);
  assert.equal((await ownerRequest(store, "overview")).accounts.length, 2);
  await assert.rejects(ownerRequest(store, "accounts/add", { id: "a", provider: "claude" }), /identity was removed/);
});

test("optional folder deletion requires matching preview and never follows profile aliases", async t => {
  const store = new StateStore(tempDir("delete-profile-")); store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const router = await startRouter(store); t.after(() => router.close());
  await ownerRequest(store, "accounts/add", { id: "dedicated", provider: "claude" });
  const preview = await ownerRequest(store, "accounts/removal-preview", { id: "dedicated" });
  assert.equal(preview.canDeleteProfile, true);
  const outside = tempDir("keep-profile-"); writeFileSync(join(outside, "keep"), "keep");
  symlinkSync(outside, join(preview.home, "linked-data"));
  writeFileSync(join(preview.home, "credentials-fixture"), "synthetic-only");
  await assert.rejects(ownerRequest(store, "accounts/remove", { ...preview, home: outside, deleteProfile: true }), /changed/);
  await assert.rejects(ownerRequest(store, "accounts/remove", { ...preview, deleteIdentity: "wrong", deleteProfile: true }), /changed/);
  assert.ok(existsSync(preview.home));
  await ownerRequest(store, "accounts/remove", { ...preview, deleteProfile: true });
  assert.equal(existsSync(preview.home), false);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "keep");

  await ownerRequest(store, "accounts/add", { id: "changed", provider: "claude" });
  const changed = await ownerRequest(store, "accounts/removal-preview", { id: "changed" });
  renameSync(changed.home, changed.home + "-original"); mkdirSync(changed.home);
  await assert.rejects(ownerRequest(store, "accounts/remove", { ...changed, deleteProfile: true }), /changed/);
  assert.ok(existsSync(changed.home + "-original"));
  renameSync(changed.home, changed.home + "-replacement"); symlinkSync(outside, changed.home);
  assert.equal((await ownerRequest(store, "accounts/removal-preview", { id: "changed" })).canDeleteProfile, false);
  await assert.rejects(ownerRequest(store, "accounts/remove", { ...changed, deleteProfile: true }), /type or owner/);
  await ownerRequest(store, "accounts/remove", { id: "changed", revision: 1 });
  assert.ok(existsSync(changed.home), "keep-folder removal does not unlink an alias");
});

test("imported, external and parent profiles cannot be recursively deleted through removal", async t => {
  const store = new StateStore(tempDir("remove-import-")); store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const imported = join(store.profilesDir, "imported"); mkdirSync(imported);
  writeClaudeCredentials(imported, "synthetic-import", Date.now() + 3600000);
  const external = tempDir("external-profile-");
  const router = await startRouter(store); t.after(() => router.close());
  await ownerRequest(store, "accounts/add", { id: "imported", provider: "claude", enrollment: "existing", home: imported, credentialStore: "file" });
  await ownerRequest(store, "accounts/add", { id: "external", provider: "claude", home: external });
  await ownerRequest(store, "accounts/add", { id: "parent", provider: "claude", home: store.profilesDir });
  for (const id of ["imported", "external", "parent"]) {
    const preview = await ownerRequest(store, "accounts/removal-preview", { id });
    assert.equal(preview.canDeleteProfile, false);
    await assert.rejects(ownerRequest(store, "accounts/remove", { ...preview, deleteProfile: true }), /Imported|Only dedicated/);
    assert.ok(existsSync(preview.home));
    await ownerRequest(store, "accounts/remove", { id, revision: 1 });
    assert.ok(existsSync(preview.home));
  }
});

test("restart finishes reference cleanup after account removal was durably saved", () => {
  const f = fixture();
  f.registry.grant({ id: f.first.id, revision: 1, poolIds: [f.pool.id], accountIds: ["a"] });
  f.store.removeAccount("a"); // Simulate a crash before the second registry write.
  const recovered = new ControlRegistry(f.store);
  assert.deepEqual(recovered.pools()[0]!.accountIds, ["b"]);
  assert.deepEqual(recovered.ownerIntegrations()[0]!.accountIds, []);
  assert.throws(() => f.store.saveAccounts([...f.store.loadAccounts(), { id: "a", provider: "claude", home: join(f.store.profilesDir, "new-a") }]), /identity was removed/);
  const first = readFileSync(join(f.store.dir, "control.json"), "utf8");
  new ControlRegistry(f.store);
  assert.equal(readFileSync(join(f.store.dir, "control.json"), "utf8"), first);
});

test("failed folder deletion retains a disabled account for recovery", { skip: process.getuid?.() === 0 }, async t => {
  const store = new StateStore(tempDir("remove-failure-")); store.init();
  writePrivateJson(store.configPath, { listen: { host: "127.0.0.1", port: 0 } });
  const router = await startRouter(store); t.after(() => router.close());
  await ownerRequest(store, "accounts/add", { id: "locked", provider: "claude" });
  const preview = await ownerRequest(store, "accounts/removal-preview", { id: "locked" });
  writeFileSync(join(preview.home, "keep"), "synthetic");
  chmodSync(preview.home, 0o500);
  try {
    await assert.rejects(ownerRequest(store, "accounts/remove", { ...preview, deleteProfile: true }), /account is disabled and remains/);
    assert.equal(store.loadAccounts()[0]!.enabled, false);
    assert.equal(router.coordinators.get("locked")!.account.enabled, false);
    assert.deepEqual(store.removedAccountIds(), []);
    assert.equal(readFileSync(join(preview.home, "keep"), "utf8"), "synthetic");
    await ownerRequest(store, "accounts/remove", { id: "locked", revision: 2 });
    assert.equal((await ownerRequest(store, "overview")).accounts.length, 0);
  } finally { chmodSync(preview.home, 0o700); }
});
