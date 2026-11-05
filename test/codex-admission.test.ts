import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PoolEvidence, eligibility, withCeiling, QUOTA_FRESH_MS } from "../src/pools.ts";
import { readAccountQuotas, codexPlanCapacityUnits, remainingCapacityUnits } from "../src/quotas.ts";
import { FIXTURES, tempDir } from "./support.ts";

test("Codex admission uses explicit ordinary-usage permission, not display percentage", async () => {
  for (const mode of ["allowed-at-limit", "denied-with-headroom"]) {
    const account = { id: "fixture", provider: "codex" as const, home: tempDir() };
    const evidence = new PoolEvidence(async () => [{ id: "model", name: "Model" }],
      () => readAccountQuotas(account, tempDir(), {
        codexCommand: process.execPath,
        codexArgs: [join(FIXTURES, "fake-codex-quotas.ts"), mode]
      }));
    const observation = await evidence.refresh(account.id);
    assert.equal(observation.quota?.status, "ok");
    assert.equal(eligibility("codex", true, "model", observation, true),
      mode === "allowed-at-limit" ? "eligible" : "exhausted");
    if (mode === "allowed-at-limit") {
      assert.equal(eligibility("codex", true, "model", withCeiling(observation, { weeklyPercent: 90 }), true), "exhausted",
        "provider permission cannot bypass the owner's usage ceiling");
      const now = Date.now();
      const stale = { ...observation, quota: { ...observation.quota!, ordinaryUsageObservedAt: new Date(now - QUOTA_FRESH_MS).toISOString() } };
      assert.equal(eligibility("codex", true, "model", stale, true, now), "quota-stale");
      evidence.observe(account.id, "codex", { "x-codex-primary-used-percent": "100" }, now + 1000);
      assert.equal(evidence.get(account.id).quota?.ordinaryUsageObservedAt, observation.quota?.ordinaryUsageObservedAt);
      assert.equal(evidence.get(account.id).quota?.planCapacityUnits, 1);
      evidence.reject(account.id, 429);
      assert.equal(eligibility("codex", true, "model", evidence.get(account.id), true), "cooldown");
    }
  }
});

test("capacity uses included allowance and preserves unknown amounts", () => {
  assert.deepEqual(["plus", "prolite", "pro", "promax", "business"].map(codexPlanCapacityUnits), [0.05, 0.5, 1, undefined, undefined]);
  const w = { bucket: "codex:primary", windowMinutes: 10080, usedPercent: 50, remainingPercent: 50, resetsAt: null };
  const q = { accountId: "a", provider: "codex" as const, observedAt: new Date().toISOString(), status: "ok" as const, windows: [w], planCapacityUnits: 0.5 };
  assert.equal(remainingCapacityUnits(q, w), 0.25);
  const { planCapacityUnits: _capacity, ...unknownPlan } = q;
  assert.equal(remainingCapacityUnits(unknownPlan, w), null);
  assert.equal(remainingCapacityUnits({ ...q, ordinaryUsageAllowed: true }, { ...w, remainingPercent: 0 }), null);
});
