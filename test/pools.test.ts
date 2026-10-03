import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ControlRegistry } from "../src/control.ts";
import { hashGatewayToken, generateGatewayToken } from "../src/gateway-auth.ts";
import { PoolEvidence, eligibility, QUOTA_FRESH_MS, type Observation } from "../src/pools.ts";
import { StateStore } from "../src/state.ts";
import { tempDir } from "./support.ts";

function fixture() {
  const store = new StateStore(tempDir("pool-")); store.init();
  store.saveAccounts(["a", "b", "c"].map(id => { const home = join(store.dir, id); mkdirSync(home); return { id, provider: "claude" as const, home }; }));
  const registry = new ControlRegistry(store), token = `aar_ctl_${Buffer.alloc(32, 5).toString("base64url")}`;
  registry.pair({ id: randomUUID(), name: "YA", tokenHash: hashGatewayToken(token) });
  const integration = registry.authenticate(`Bearer ${token}`), poolId = randomUUID();
  const pool = { id: poolId, name: "Personal", provider: "claude", accountIds: ["a", "b"], policy: "round-robin", revision: 0 };
  registry.savePool(pool);
  registry.grant({ id: integration.id, revision: 1, poolIds: [pool.id] });
  const evidence = new PoolEvidence(async () => [{ id: "claude-sonnet-fixture", name: "Fixture" }], async accountId => ({ accountId, provider: "claude", observedAt: new Date(Date.now()).toISOString(), status: "ok", windows: [{ bucket: "five_hour", windowMinutes: 300, usedPercent: 25, remainingPercent: 75, resetsAt: new Date(Date.now() + 60_000).toISOString() }] }));
  const allocation = () => ({ id: randomUUID(), poolId, provider: "claude", model: "claude-sonnet-fixture", tokenHash: hashGatewayToken(generateGatewayToken()) });
  return { store, registry, token, integration, pool, evidence, allocation };
}

test("pool round robin is atomic, durable and idempotent through commit, cancellation and restart", async () => {
  const f = fixture();
  await Promise.all([f.evidence.refresh("a"), f.evidence.refresh("b")]);
  const first = f.allocation(), second = f.allocation();
  const results = await Promise.all([first, second].map(body => Promise.resolve().then(() => f.registry.preparePool(f.integration, body, f.evidence) as any)));
  assert.deepEqual(results.map(r => r.accountId), ["a", "b"], "parallel starts reserve distinct accounts");
  assert.deepEqual(f.registry.preparePool(f.integration, first, f.evidence), results[0]);
  f.registry.transition(f.integration, second.id, "cancel");
  f.registry.transition(f.integration, first.id, "commit", f.evidence);
  f.registry.transition(f.integration, first.id, "commit", f.evidence);
  const registry = new ControlRegistry(f.store), integration = registry.authenticate(`Bearer ${f.token}`);
  assert.equal((registry.preparePool(integration, f.allocation(), f.evidence) as any).accountId, "b");
  assert.equal((registry.preparePool(integration, first, f.evidence) as any).accountId, "a");
  assert.throws(() => registry.preparePool(integration, { ...first, model: "changed" }, f.evidence), /conflicts/);
  assert.equal(registry.clients().length, 1);
  assert.doesNotMatch(JSON.stringify(registry.overview(integration, f.evidence)), /tokenHash|integrationId|cursor|home/);
  assert.equal(readFileSync(join(f.store.dir, "control.json"), "utf8").includes(f.token), false);
});

test("pool edits are scoped, revision checked, and revoke removed pins without switching", async () => {
  const f = fixture(); await f.evidence.refresh("a");
  const body = { ...f.allocation(), policy: "manual", accountId: "a" };
  f.registry.preparePool(f.integration, body, f.evidence); f.registry.transition(f.integration, body.id, "commit", f.evidence);
  assert.throws(() => f.registry.savePool(f.pool), /changed/);
  assert.throws(() => f.registry.savePool({ ...f.pool, revision: 1, accountIds: ["not-granted"] }), /provider mismatch/);
  const otherToken = `aar_ctl_${Buffer.alloc(32, 6).toString("base64url")}`;
  f.registry.pair({ id: randomUUID(), name: "Other", tokenHash: hashGatewayToken(otherToken) });
  const other = f.registry.authenticate(`Bearer ${otherToken}`);
  assert.throws(() => f.registry.pool(other, f.pool.id), /not found/);
  f.registry.savePool({ ...f.pool, revision: 1, accountIds: ["b"] });
  assert.equal(f.registry.clients().length, 0);
  assert.throws(() => f.registry.transition(f.integration, body.id, "inspect"), /removed/);
  f.registry.transition(f.integration, body.id, "cancel");
  f.registry.removePool({ id: f.pool.id, revision: 2 });
  assert.throws(() => f.registry.savePool({ ...f.pool, revision: 3 }), /identity/);
});

test("eligibility handles stale, unknown, model-scoped exhaustion and elapsed resets conservatively", () => {
  const now = Date.now();
  const o: Observation = { models: [{ id: "claude-sonnet-fixture", name: "Fixture" }], catalogAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(), error: null,
    quota: { accountId: "a", provider: "claude", status: "ok", observedAt: new Date(now).toISOString(), windows: [{ bucket: "five_hour", windowMinutes: 300, usedPercent: 25, remainingPercent: 75, resetsAt: new Date(now + 60000).toISOString() }, { bucket: "seven_day_opus", windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetsAt: new Date(now + 60000).toISOString() }] } };
  const decide = (value = o, automatic = true) => eligibility("claude", true, "claude-sonnet-fixture", value, automatic, now);
  assert.equal(decide(), "eligible", "unrelated Opus exhaustion does not block Sonnet");
  assert.equal(decide({ ...o, quota: null }), "quota-unknown");
  assert.equal(decide({ ...o, quota: null }, false), "eligible");
  assert.equal(decide({ ...o, quota: { ...o.quota!, observedAt: new Date(now - QUOTA_FRESH_MS).toISOString() } }), "quota-stale");
  o.quota!.windows[0]!.resetsAt = new Date(now - 1).toISOString(); assert.equal(decide(), "reset-unverified");
  o.quota!.windows[0]!.remainingPercent = 0; assert.equal(decide(o, false), "exhausted");
  o.quota!.windows[0]!.remainingPercent = null; assert.equal(decide(), "quota-unknown");
  o.quota!.windows[0] = { ...o.quota!.windows[0]!, remainingPercent: 20, bucket: "unknown" }; assert.equal(decide(), "scope-unknown");
});

test("overview is passive; refresh coalesces, bounds concurrency, retains failed evidence and honors rejections", async () => {
  let reads = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const evidence = new PoolEvidence(async () => { await wait; return [{ id: "fixture", name: "Fixture" }]; }, async accountId => { reads++; await wait; return { accountId, provider: "codex", observedAt: new Date(Date.now()).toISOString(), status: "ok", windows: [] }; });
  const f = fixture(); f.registry.overview(f.integration, evidence); assert.equal(reads, 0);
  const pending = evidence.refresh("a"); assert.equal(evidence.refresh("a"), pending);
  const others = ["b", "c", "d"].map(id => evidence.refresh(id));
  await assert.rejects(evidence.refresh("e"), /busy/);
  evidence.reject("a", 429, "60"); release(); await Promise.all([pending, ...others]);
  assert.equal(evidence.get("a").blocked, "cooldown", "in-flight refresh cannot erase later rejection");
  assert.equal(reads, 4);
  const failed = new PoolEvidence(async () => { throw new Error("secret"); }, async () => { throw new Error("secret"); });
  assert.doesNotMatch(JSON.stringify(await failed.refresh("a")), /secret/);
});

test("unknown evidence refuses automatic admission but explicit Manual uses validated catalog", async () => {
  const f = fixture();
  assert.throws(() => f.registry.preparePool(f.integration, f.allocation(), f.evidence), /no eligible/);
  f.evidence.setCatalog("a", [{ id: "claude-sonnet-fixture", name: "Fixture" }]);
  const manualView = f.registry.overview(f.integration, f.evidence, { poolId: f.pool.id, model: "claude-sonnet-fixture", policy: "manual" }) as any;
  assert.equal(manualView.selection.decisions[0].reason, "eligible");
  const autoView = f.registry.overview(f.integration, f.evidence, { poolId: f.pool.id, model: "claude-sonnet-fixture" }) as any;
  assert.equal(autoView.selection.decisions[0].reason, "quota-unknown");
  const selected = f.registry.preparePool(f.integration, { ...f.allocation(), policy: "manual", accountId: "a" }, f.evidence) as any;
  assert.equal(selected.accountId, "a");
  f.store.saveAccounts(f.store.loadAccounts().map(a => ({ ...a, enabled: false })));
  assert.throws(() => f.registry.transition(f.integration, selected.id, "commit", f.evidence), /unavailable/);
  f.registry.transition(f.integration, selected.id, "cancel");
});

test("cancel before prepare is terminal and does not strand the next valid allocation", async () => {
  const f = fixture(); await f.evidence.refresh("a");
  const body = f.allocation();
  assert.deepEqual(f.registry.transition(f.integration, body.id, "cancel"), { id: body.id, state: "cancelled" });
  const registry = new ControlRegistry(f.store), integration = registry.authenticate(`Bearer ${f.token}`);
  assert.throws(() => registry.preparePool(integration, body, f.evidence), /cancelled/);
  assert.throws(() => registry.prepare(integration, { ...body, accountId: "a" }), /cancelled/);
  assert.equal((registry.preparePool(integration, f.allocation(), f.evidence) as any).accountId, "a");
});

test("default-policy changes do not rerun an existing selection", async () => {
  const f = fixture(); await f.evidence.refresh("a");
  const body = f.allocation(), first = f.registry.preparePool(f.integration, body, f.evidence);
  f.registry.transition(f.integration, body.id, "commit", f.evidence);
  f.registry.savePool({ ...f.pool, revision: 1, policy: "manual" });
  assert.deepEqual({ ...(first as object), state: "committed" }, f.registry.preparePool(f.integration, body, f.evidence));
});


test("expired startup reservations do not crowd the next start; changed evidence blocks commit", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = fixture(); await Promise.all([f.evidence.refresh("a"), f.evidence.refresh("b")]);
  const abandoned = f.allocation(); f.registry.preparePool(f.integration, abandoned, f.evidence);
  now += 301_000;
  await Promise.all([f.evidence.refresh("a"), f.evidence.refresh("b")]);
  const next = f.allocation(); assert.equal((f.registry.preparePool(f.integration, next, f.evidence) as any).accountId, "a");
  assert.throws(() => f.registry.transition(f.integration, abandoned.id, "commit", f.evidence), /expired/);
  f.evidence.reject("a", 429, "60");
  assert.throws(() => f.registry.transition(f.integration, next.id, "commit", f.evidence), /evidence changed/);
  f.registry.transition(f.integration, next.id, "cancel", f.evidence);
});


test("manual version-one state upgrades without losing identity or grants", () => {
  const f = fixture(), path = join(f.store.dir, "control.json"), old = JSON.parse(readFileSync(path, "utf8"));
  old.version = 1; delete old.pools; writeFileSync(path, JSON.stringify(old));
  const registry = new ControlRegistry(f.store);
  assert.equal(registry.routerId, old.routerId);
  assert.equal(registry.authenticate(`Bearer ${f.token}`).id, f.integration.id);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3);
});


test("a failed refresh retains successful windows with stale evidence and clears only after recovery", async t => {
  let now = Date.now(), fail = false; t.mock.method(Date, "now", () => now);
  const evidence = new PoolEvidence(async () => [{ id: "fixture", name: "Fixture" }], async accountId => fail ? { accountId, provider: "codex", status: "unavailable", observedAt: new Date(now).toISOString(), windows: [], error: "safe failure" } : { accountId, provider: "codex", status: "ok", observedAt: new Date(now).toISOString(), windows: [{ bucket: "codex:primary", windowMinutes: 300, usedPercent: 20, remainingPercent: 80, resetsAt: new Date(now + 3600000).toISOString() }] });
  const original = await evidence.refresh("a"); fail = true; now += 2000;
  const failed = await evidence.refresh("a"); assert.deepEqual(failed.quota, original.quota); assert.ok(failed.error);
  assert.equal(eligibility("codex", true, "fixture", failed, true, now), "quota-unknown");
  fail = false; now += 6000; const recovered = await evidence.refresh("a");
  assert.equal(recovered.error, null); assert.equal(eligibility("codex", true, "fixture", recovered, true, now), "eligible");
});
