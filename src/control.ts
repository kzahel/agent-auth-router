// Local control protocol v1. The private socket bootstraps owner pairing;
// integration credentials authorize all subsequent operations.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { hashGatewayToken } from "./gateway-auth.ts";
import { ADAPTERS, parseUpstreamOrigin } from "./providers.ts";
import { fetchAccountQuotas, type QuotaReadOptions } from "./quotas.ts";
import { PoolEvidence, eligibility, windowScope, QUOTA_FRESH_MS, type Pool, type PoolPolicy } from "./pools.ts";
import type { CredentialCoordinator } from "./coordinator.ts";
import type { StateStore } from "./state.ts";
import type { GatewayClientRecord, Provider } from "./types.ts";

interface Integration { id: string; name: string; tokenHash: string; accountIds: string[]; revoked: boolean }
interface Binding {
  id: string; integrationId: string; accountId: string; provider: Provider;
  model: string; tokenHash: string; state: "prepared" | "committed" | "cancelled";
  createdAt: number;
  poolId?: string; policy?: PoolPolicy; request?: string; reason?: string; observedAt?: string | undefined;
}
interface ControlState { version: 2; routerId: string; integrations: Integration[]; bindings: Binding[]; pools?: Pool[]; cancellations?: { id: string; integrationId: string }[] }
export interface CatalogModel { id: string; name: string; contextWindow?: number }
export class ControlError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const reject = (status: number, message: string): never => { throw new ControlError(status, message); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const PREPARE_MS = 5 * 60_000;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(400, "expected object");
  return value as Record<string, unknown>;
}
function field(body: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = body[key];
  if (typeof value !== "string" || !value.length || value.length > 200 || (pattern && !pattern.test(value))) reject(400, `invalid ${key}`);
  return value as string;
}
function equalHash(a: string, b: string): boolean {
  return HASH.test(a) && HASH.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Atomic, durable single-file transactions. Only the socket owner writes. */
function persist(path: string, value: ControlState): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(join(path, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function assertPrivatePath(path: string, socket = false): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (socket ? !st.isSocket() : !st.isDirectory()) || st.uid !== process.getuid?.() || (st.mode & 0o077)) {
    reject(400, "control endpoint must be private and owned by this user");
  }
}

export class ControlRegistry {
  private state: ControlState;
  private readonly path: string;
  private readonly store: StateStore;
  constructor(store: StateStore) {
    this.store = store;
    this.path = join(store.dir, "control.json");
    if (existsSync(this.path)) {
      const st = lstatSync(this.path);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error("insecure control state");
      this.state = JSON.parse(readFileSync(this.path, "utf8")) as ControlState;
      if (![1, 2].includes(this.state.version) || !UUID.test(this.state.routerId) || !Array.isArray(this.state.integrations) || !Array.isArray(this.state.bindings)) throw new Error("invalid control state");
      if ((this.state.version as number) === 1) { this.state.version = 2; persist(this.path, this.state); }
    } else {
      this.state = { version: 2, routerId: randomUUID(), integrations: [], bindings: [] };
      persist(this.path, this.state);
    }
  }
  pools(integration: Integration): Pool[] { return (this.state.pools ?? []).filter(p => p.integrationId === integration.id && !p.deleted); }
  pool(integration: Integration, id: string): Pool {
    return this.pools(integration).find(p => p.id === id) ?? reject(404, "pool not found");
  }
  savePool(integration: Integration, body: Record<string, unknown>): object {
    const id = field(body, "id", UUID), name = field(body, "name");
    if (name.length > 80 || !name.trim()) reject(400, "invalid pool name");
    const existing = (this.state.pools ?? []).find(p => p.id === id);
    if (existing && (existing.integrationId !== integration.id || existing.deleted)) reject(409, "pool identity unavailable");
    if (body.revision !== (existing?.revision ?? 0)) reject(409, "pool changed; reload before editing");
    if (body.provider !== "codex" && body.provider !== "claude") reject(400, "invalid pool provider");
    if (existing && body.provider !== existing.provider) reject(409, "pool provider cannot change");
    if (body.policy !== "manual" && body.policy !== "round-robin") reject(400, "invalid pool policy");
    const accountIds = body.accountIds;
    if (!Array.isArray(accountIds) || !accountIds.length || accountIds.length > 16 || new Set(accountIds).size !== accountIds.length) reject(400, "choose 1 to 16 distinct pool accounts");
    for (const id of accountIds as unknown[]) {
      if (typeof id !== "string" || !integration.accountIds.includes(id)) reject(403, "account not granted");
      const account = this.store.loadAccounts().find(a => a.id === id);
      if (!account || account.provider !== body.provider) reject(400, "pool account provider mismatch");
    }
    if (!existing && (this.state.pools?.length ?? 0) >= 256) reject(409, "pool limit reached");
    const pool: Pool = { id, integrationId: integration.id, name: name.trim(), provider: body.provider as Provider,
      accountIds: accountIds as string[], policy: body.policy as PoolPolicy, revision: (existing?.revision ?? 0) + 1,
      ...(existing?.cursor ? { cursor: existing.cursor } : {}) };
    this.change(state => { state.pools ??= []; const index = state.pools.findIndex(p => p.id === id); if (index < 0) state.pools.push(pool); else state.pools[index] = pool; });
    return this.poolMetadata(pool);
  }
  removePool(integration: Integration, body: Record<string, unknown>): object {
    const pool = this.pool(integration, field(body, "id", UUID));
    if (body.revision !== pool.revision) reject(409, "pool changed; reload before deleting");
    this.change(state => { const p = state.pools!.find(p => p.id === pool.id)!; p.deleted = true; p.revision++; });
    return { deleted: true };
  }
  private poolAllows(b: Binding): boolean {
    if (!b.poolId) return true;
    const p = this.state.pools?.find(p => p.id === b.poolId && p.integrationId === b.integrationId && !p.deleted);
    return !!p?.accountIds.includes(b.accountId);
  }
  poolMetadata(p: Pool): object {
    return { id: p.id, name: p.name, provider: p.provider, accountIds: p.accountIds, policy: p.policy, revision: p.revision,
      bindings: p.accountIds.map(accountId => ({ accountId, count: this.state.bindings.filter(b => b.poolId === p.id && b.accountId === accountId && b.state === "committed").length })) };
  }
  overview(integration: Integration, evidence: PoolEvidence, body: Record<string, unknown> = {}): object {
    const now = Date.now(), model = body.model === undefined ? undefined : field(body, "model");
    const accounts = this.accounts(integration).map(a => { const o = evidence.get(a.id); return { ...a, ...o,
      freshness: !o.quota ? "unknown" : o.error || now - Date.parse(o.quota.observedAt) >= QUOTA_FRESH_MS ? "stale" : "fresh",
      windows: o.quota?.windows.map(w => ({ ...w, scope: windowScope(a.provider, w.bucket) })) ?? [] }; });
    const pool = body.poolId === undefined ? undefined : this.pool(integration, field(body, "poolId", UUID));
    const decisions = pool?.accountIds.map(accountId => { const a = accounts.find(a => a.id === accountId); return { accountId,
      reason: eligibility(pool.provider, !!a?.enabled && integration.accountIds.includes(accountId), model, evidence.get(accountId), true, now) }; });
    return { observedAt: new Date(now).toISOString(), quotaFreshSeconds: QUOTA_FRESH_MS / 1000,
      pools: this.pools(integration).map(p => this.poolMetadata(p)), accounts,
      ...(pool ? { selection: { poolId: pool.id, model: model ?? null, decisions } } : {}) };
  }
  preparePool(integration: Integration, body: Record<string, unknown>, evidence: PoolEvidence): object {
    const id = field(body, "id", UUID), poolId = field(body, "poolId", UUID), model = field(body, "model"), tokenHash = field(body, "tokenHash", HASH);
    const pool = this.pool(integration, poolId);
    if (body.provider !== pool.provider) reject(400, "provider mismatch");
    const requestedPolicy = body.policy;
    if (requestedPolicy !== undefined && requestedPolicy !== "manual" && requestedPolicy !== "round-robin") reject(400, "invalid pool policy");
    const manual = body.accountId === undefined ? undefined : field(body, "accountId");
    const request = JSON.stringify([poolId, model, body.provider, requestedPolicy ?? null, manual ?? null, tokenHash]);
    if (this.state.cancellations?.some(c => c.id === id && c.integrationId === integration.id)) reject(409, "allocation cancelled");
    const existing = this.state.bindings.find(b => b.id === id);
    if (existing) {
      if (existing.integrationId !== integration.id || existing.request !== request) reject(409, "allocation conflicts with existing pin");
      if (!this.poolAllows(existing)) reject(409, "pinned account removed from pool");
      return this.prepare(integration, { id, accountId: existing.accountId, provider: existing.provider, model, tokenHash });
    }
    const policy = (requestedPolicy ?? pool.policy) as PoolPolicy;
    if (policy === "manual" && !manual) reject(400, "manual pool selection requires an account");
    if (policy === "round-robin" && manual) reject(400, "round robin cannot specify an account");
    const now = Date.now();
    const eligible = pool.accountIds.filter(accountId => {
      const a = this.store.loadAccounts().find(a => a.id === accountId && integration.accountIds.includes(accountId));
      return eligibility(pool.provider, !!a && a.enabled !== false, model, evidence.get(accountId), policy === "round-robin", now) === "eligible";
    });
    let chosen = manual;
    if (chosen && !eligible.includes(chosen)) reject(409, "manual account is not eligible; refresh pool overview");
    if (!chosen) {
      const cursor = pool.cursor ? pool.accountIds.indexOf(pool.cursor) : -1;
      const ordered = [...pool.accountIds.slice(cursor + 1), ...pool.accountIds.slice(0, cursor + 1)].filter(id => eligible.includes(id));
      const reserved = (accountId: string) => this.state.bindings.filter(b => b.poolId === pool.id && b.accountId === accountId && b.state === "prepared" && b.createdAt + PREPARE_MS > now).length;
      chosen = ordered.sort((a, b) => reserved(a) - reserved(b))[0];
    }
    if (!chosen) reject(409, "no eligible pool account; refresh usage or choose Manual");
    if (this.state.bindings.length >= 100_000) reject(409, "binding limit reached");
    const binding: Binding = { id, integrationId: integration.id, accountId: chosen!, provider: pool.provider, model, tokenHash,
      state: "prepared", createdAt: now, poolId, policy, request,
      reason: policy === "round-robin" ? "Round robin among eligible accounts" : "Explicit manual account",
      observedAt: evidence.get(chosen!).quota?.observedAt };
    this.change(state => state.bindings.push(binding));
    return this.metadata(binding);
  }
  get routerId(): string { return this.state.routerId; }
  private change(edit: (state: ControlState) => void): void {
    const next = structuredClone(this.state);
    edit(next);
    persist(this.path, next);
    this.state = next;
  }
  pair(body: Record<string, unknown>): object {
    const id = field(body, "id", UUID), name = field(body, "name"), tokenHash = field(body, "tokenHash", HASH);
    const existing = this.state.integrations.find((i) => i.id === id);
    if (existing) {
      if (existing.revoked || !equalHash(existing.tokenHash, tokenHash)) reject(409, "pairing identity already used");
      return { id, routerId: this.routerId };
    }
    if (this.state.integrations.length >= 256) reject(409, "integration limit reached");
    const accountIds = this.store.loadAccounts().filter((a) => a.enabled !== false).map((a) => a.id);
    this.change((state) => state.integrations.push({ id, name, tokenHash, accountIds, revoked: false }));
    return { id, routerId: this.routerId };
  }
  authenticate(authorization: string | undefined): Integration {
    const token = authorization?.match(/^Bearer (aar_ctl_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return reject(401, "control credential required");
    const hash = hashGatewayToken(token);
    return this.state.integrations.find((i) => !i.revoked && equalHash(i.tokenHash, hash)) ?? reject(401, "control credential revoked or unknown");
  }
  account(integration: Integration, id: string) {
    if (!integration.accountIds.includes(id)) return reject(403, "account not granted");
    return this.store.loadAccounts().find((a) => a.id === id && a.enabled !== false) ?? reject(409, "account unavailable");
  }
  accounts(integration: Integration) {
    return this.store.loadAccounts().filter((a) => integration.accountIds.includes(a.id)).map((a) => ({ id: a.id, provider: a.provider, enabled: a.enabled !== false, renewal: a.helper ? "unverified" : "manual" }));
  }
  prepare(integration: Integration, body: Record<string, unknown>): object {
    const id = field(body, "id", UUID), accountId = field(body, "accountId"), model = field(body, "model"), tokenHash = field(body, "tokenHash", HASH);
    const account = this.account(integration, accountId);
    if (body.provider !== account.provider) reject(400, "provider mismatch");
    if (this.state.cancellations?.some(c => c.id === id && c.integrationId === integration.id)) reject(409, "allocation cancelled");
    const existing = this.state.bindings.find((b) => b.id === id);
    if (existing) {
      if (existing.integrationId !== integration.id || existing.accountId !== accountId || existing.model !== model || !equalHash(existing.tokenHash, tokenHash)) reject(409, "allocation conflicts with existing pin");
      if (existing.state === "cancelled") reject(409, "allocation cancelled");
      if (existing.state === "prepared" && existing.createdAt + PREPARE_MS <= Date.now()) reject(409, "allocation expired");
      return this.metadata(existing);
    }
    if (this.state.bindings.length >= 100_000) reject(409, "binding limit reached");
    const binding: Binding = { id, integrationId: integration.id, accountId, provider: account.provider, model, tokenHash, state: "prepared", createdAt: Date.now() };
    this.change((state) => state.bindings.push(binding));
    return this.metadata(binding);
  }
  hasBinding(integration: Integration, id: string): boolean { return this.state.bindings.some(b => b.id === id && b.integrationId === integration.id); }
  binding(integration: Integration, id: string): Binding {
    return this.state.bindings.find((b) => b.id === id && b.integrationId === integration.id) ?? reject(404, "binding not found");
  }
  metadata(b: Binding): object {
    return { id: b.id, accountId: b.accountId, provider: b.provider, model: b.model, state: b.state, policy: b.policy ?? "manual", ...(b.poolId ? { poolId: b.poolId, policyVersion: 1, reason: b.reason, observedAt: b.observedAt } : {}), routerId: this.routerId };
  }
  transition(integration: Integration, id: string, action: "commit" | "cancel" | "inspect", evidence?: PoolEvidence): object {
    if (action === "cancel" && !this.state.bindings.some(b => b.id === id && b.integrationId === integration.id)) {
      if (!this.state.cancellations?.some(c => c.id === id && c.integrationId === integration.id)) {
        if ((this.state.cancellations?.length ?? 0) >= 100_000) reject(409, "cancellation limit reached");
        this.change(state => { state.cancellations ??= []; state.cancellations.push({ id, integrationId: integration.id }); });
      }
      return { id, state: "cancelled" };
    }
    const b = this.binding(integration, id);
    if (action !== "cancel") { this.account(integration, b.accountId); if (!this.poolAllows(b)) reject(409, "pinned account removed from pool"); }
    if (action === "inspect") return this.metadata(b);
    if (action === "commit" && (b.state === "cancelled" || (b.state === "prepared" && b.createdAt + PREPARE_MS <= Date.now()))) reject(409, "allocation cancelled or expired");
    if (action === "commit" && b.state === "prepared" && b.poolId && (!evidence || eligibility(b.provider, true, b.model, evidence.get(b.accountId), b.policy === "round-robin") !== "eligible")) reject(409, "pool evidence changed; refresh and start a new session");
    const state = action === "commit" ? "committed" : "cancelled";
    this.change((next) => {
      next.bindings.find((v) => v.id === id)!.state = state;
      if (action === "commit" && b.state === "prepared" && b.poolId && b.policy === "round-robin") next.pools!.find(p => p.id === b.poolId)!.cursor = b.accountId;
    });
    return this.metadata({ ...b, state });
  }
  revoke(integration: Integration): object {
    this.change((state) => { state.integrations.find((i) => i.id === integration.id)!.revoked = true; });
    return { revoked: true };
  }
  clients(): GatewayClientRecord[] {
    const integrations = new Map(this.state.integrations.filter((i) => !i.revoked).map((i) => [i.id, i]));
    const enabled = new Set(this.store.loadAccounts().filter((a) => a.enabled !== false).map((a) => a.id));
    return this.state.bindings.filter((b) => b.state === "committed" && this.poolAllows(b) && integrations.get(b.integrationId)?.accountIds.includes(b.accountId) && enabled.has(b.accountId)).map((b) => ({ id: b.id, name: b.id, tokenSha256: b.tokenHash, accounts: { [b.provider]: b.accountId }, createdAt: new Date(b.createdAt).toISOString() }));
  }
}

export async function readCatalog(coordinator: CredentialCoordinator, origin?: string): Promise<CatalogModel[]> {
  const provider = coordinator.account.provider, adapter = ADAPTERS[provider];
  const credential = await coordinator.credential();
  const url = new URL(provider === "claude" ? "/v1/models" : "/backend-api/codex/models?client_version=0.159.0", parseUpstreamOrigin(origin ?? adapter.defaultOrigin));
  const value = await new Promise<unknown>((resolve, rejectPromise) => {
    const request = (url.protocol === "https:" ? https : http).get(url, { headers: { ...adapter.upstreamHeaders(credential, {}), accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); rejectPromise(new ControlError(502, "account catalog unavailable")); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error("catalog too large")); else chunks.push(chunk); });
      response.on("error", () => rejectPromise(new ControlError(502, "catalog read failed")));
      response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { rejectPromise(new ControlError(502, "invalid catalog")); } });
    });
    const timeout = setTimeout(() => request.destroy(new Error("deadline")), 15_000);
    request.on("close", () => clearTimeout(timeout));
    request.on("error", () => rejectPromise(new ControlError(502, "catalog unavailable")));
  });
  const raw = record(value), rows = raw.data ?? raw.models;
  if (!Array.isArray(rows)) reject(502, "invalid catalog");
  return (rows as unknown[]).slice(0, 512).flatMap((value) => {
    const row = record(value), id = row.id ?? row.slug;
    if (typeof id !== "string" || !id.length || id.length > 200) return [];
    const name = row.display_name ?? row.name ?? id;
    return [{ id, name: typeof name === "string" ? name.slice(0, 200) : id,
      ...(typeof row.context_window === "number" ? { contextWindow: row.context_window } : {}) }];
  });
}

export async function startControl(store: StateStore, origin: string, coordinators: Map<string, CredentialCoordinator>, quotaOptions: QuotaReadOptions = {}) {
  assertPrivatePath(store.dir);
  const socketPath = join(store.dir, "control.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("control socket path too long; choose a shorter state directory");
  // Refuse occupied/stale paths. Never unlink a path we did not create.
  if (existsSync(socketPath)) throw new Error("control socket exists; verify its owner before removing stale state");
  let registry: ControlRegistry;
  const catalogJobs = new Map<string, Promise<CatalogModel[]>>();
  const quotaJobs = new Map<string, ReturnType<typeof fetchAccountQuotas>>();
  const catalogs = new Map<string, { models: CatalogModel[]; until: number }>();
  const catalog = (id: string, fresh = false) => {
    const cached = catalogs.get(id);
    if (!fresh && cached && cached.until > Date.now()) return Promise.resolve(cached.models);
    let job = catalogJobs.get(id);
    if (!job) {
      const coordinator = coordinators.get(id) ?? reject(409, "account unavailable; restart router after enrollment");
      job = readCatalog(coordinator, store.loadConfig().upstreams?.[coordinator.account.provider]).then((models) => { catalogs.set(id, { models, until: Date.now() + 60_000 }); return models; }).finally(() => catalogJobs.delete(id));
      catalogJobs.set(id, job);
    }
    return job;
  };
  const evidence = new PoolEvidence(id => catalog(id, true), id => fetchAccountQuotas(store.loadAccounts().find(a => a.id === id)!, store.workDir, quotaOptions));
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (++active > 16) { active--; reply(503, { error: "control busy" }); req.resume(); return; }
    res.once("close", () => { active--; });
    void (async () => {
      if (req.headers.origin || req.headers.host !== "localhost") reject(403, "invalid control origin");
      const path = req.url;
      if (req.method === "GET" && path === "/v1/info") return reply(200, { protocol: 1, routerId: registry.routerId, inferenceOrigin: origin, capabilities: ["manual-bindings", "account-catalogs", "account-quotas", "pools-v1"] });
      let integration = path === "/v1/pair" ? undefined : registry.authenticate(req.headers.authorization);
      if (req.method === "GET" && path === "/v1/accounts" && integration) return reply(200, { accounts: registry.accounts(integration) });
      if (req.method !== "POST") reject(404, "unknown control operation");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16_384) reject(413, "request too large"); chunks.push(chunk); }
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(Buffer.concat(chunks).toString())); } catch { return reject(400, "invalid JSON request"); }
      if (path === "/v1/pair") return reply(200, registry.pair(body));
      integration = registry.authenticate(req.headers.authorization);
      if (path === "/v1/pools/save") return reply(200, registry.savePool(integration, body));
      if (path === "/v1/pools/remove") return reply(200, registry.removePool(integration, body));
      if (path === "/v1/overview") return reply(200, registry.overview(integration, evidence, body));
      if (path === "/v1/overview/refresh") {
        const account = registry.account(integration, field(body, "accountId"));
        await evidence.refresh(account.id);
        return reply(200, registry.overview(registry.authenticate(req.headers.authorization), evidence, body));
      }
      if (path === "/v1/pools/prepare") {
        if (!registry.hasBinding(integration, field(body, "id", UUID)) && (body.policy === "manual" || (body.policy === undefined && registry.pool(integration, field(body, "poolId", UUID)).policy === "manual"))) {
          const account = registry.account(integration, field(body, "accountId"));
          evidence.setCatalog(account.id, await catalog(account.id, true));
        }
        return reply(200, registry.preparePool(registry.authenticate(req.headers.authorization), body, evidence));
      }
      if (path === "/v1/disconnect") return reply(200, registry.revoke(integration));
      if (path === "/v1/catalog" || path === "/v1/quotas") {
        const account = registry.account(integration, field(body, "accountId"));
        if (path === "/v1/catalog") return reply(200, { models: await catalog(account.id) });
        let job = quotaJobs.get(account.id);
        if (!job) { job = fetchAccountQuotas(account, store.workDir, quotaOptions).finally(() => quotaJobs.delete(account.id)); quotaJobs.set(account.id, job); }
        return reply(200, await job);
      }
      if (path === "/v1/bindings/prepare") {
        const account = registry.account(integration, field(body, "accountId"));
        const model = field(body, "model");
        if (!(await catalog(account.id)).some((m) => m.id === model)) reject(409, "model absent from account catalog");
        // Reauthenticate after asynchronous reads: revocation wins admission races.
        return reply(200, registry.prepare(registry.authenticate(req.headers.authorization), body));
      }
      if (path === "/v1/bindings/commit" || path === "/v1/bindings/cancel" || path === "/v1/bindings/inspect") {
        return reply(200, registry.transition(integration, field(body, "id", UUID), path.slice(path.lastIndexOf("/") + 1) as "commit" | "cancel" | "inspect", evidence));
      }
      reject(404, "unknown control operation");
    })().catch((error: unknown) => { if (!res.destroyed && !res.headersSent) reply(error instanceof ControlError ? error.status : 503, { error: error instanceof ControlError ? error.message : "control operation unavailable" }); });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 20_000;
  await new Promise<void>((resolve, rejectPromise) => { server.once("error", rejectPromise); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  const identity = lstatSync(socketPath);
  try { registry = new ControlRegistry(store); } catch (error) { server.close(); throw error; }
  return { registry, evidence, socketPath, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(socketPath)) { const current = lstatSync(socketPath); if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(socketPath); }
  } };
}
