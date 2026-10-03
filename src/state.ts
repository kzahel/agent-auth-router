// Router-owned state: listener config, account registry and gateway client
// registry, stored as JSON in a private directory. Provider credentials are
// never stored here; account entries only point at dedicated profile homes.

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseUpstreamOrigin } from "./providers.ts";
import { isProvider, type AccountConfig, type GatewayClientRecord, type RouterConfig } from "./types.ts";

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AAR_STATE_DIR ?? join(homedir(), ".agent-auth-router"));
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  if (process.platform !== "win32") { const parent = openSync(join(path, ".."), "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export class StateStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  get configPath(): string {
    return join(this.dir, "config.json");
  }
  get accountsPath(): string {
    return join(this.dir, "accounts.json");
  }
  get clientsPath(): string {
    return join(this.dir, "clients.json");
  }
  get profilesDir(): string {
    return join(this.dir, "profiles");
  }
  get workDir(): string {
    return join(this.dir, "helper-cwd");
  }

  init(): void {
    ensurePrivateDir(this.dir);
    ensurePrivateDir(this.profilesDir);
    ensurePrivateDir(this.workDir);
  }

  upgradeRegistries(): void {
    for (const [path, read, save] of [
      [this.accountsPath, () => this.loadAccounts(), (value: unknown) => this.saveAccounts(value as AccountConfig[])],
      [this.clientsPath, () => this.loadClients(), (value: unknown) => this.saveClients(value as GatewayClientRecord[])],
    ] as const) {
      if (!existsSync(path) || Array.isArray(JSON.parse(readFileSync(path, "utf8")))) {
        const value = read();
        if (existsSync(path) && !existsSync(`${path}.pre-v3`)) writePrivateJson(`${path}.pre-v3`, JSON.parse(readFileSync(path, "utf8")));
        save(value);
      }
    }
  }

  loadConfig(): RouterConfig {
    const config = readJsonFile<RouterConfig>(this.configPath, { listen: { host: "127.0.0.1", port: 8417 } });
    return validateConfig(config);
  }

  loadAccounts(): AccountConfig[] {
    const value = readJsonFile<AccountConfig[] | { version: number; accounts: AccountConfig[] }>(this.accountsPath, []);
    if (Array.isArray(value)) return validateAccounts(value);
    if (value.version !== 3) throw new Error("unsupported account registry version");
    return validateAccounts(value.accounts);
  }

  saveAccounts(accounts: AccountConfig[]): void {
    writePrivateJson(this.accountsPath, { version: 3, accounts: validateAccounts(accounts) });
  }

  loadClients(): GatewayClientRecord[] {
    const value = readJsonFile<GatewayClientRecord[] | { version: number; clients: GatewayClientRecord[] }>(this.clientsPath, []);
    if (Array.isArray(value)) return value;
    if (value.version !== 3 || !Array.isArray(value.clients)) throw new Error("unsupported client registry version");
    return value.clients;
  }

  saveClients(clients: GatewayClientRecord[]): void {
    writePrivateJson(this.clientsPath, { version: 3, clients });
  }
}

/**
 * Rereads the client registry when the file changes so revocation applies
 * to the next request without a restart.
 */
export class LiveClients {
  private readonly store: StateStore;
  private cached: GatewayClientRecord[] = [];
  private stamp = "";
  constructor(store: StateStore) {
    this.store = store;
  }

  current(): GatewayClientRecord[] {
    let next = "absent";
    try {
      const stat = statSync(this.store.clientsPath);
      next = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {}
    if (next !== this.stamp) {
      this.cached = this.store.loadClients();
      this.stamp = next;
    }
    return this.cached;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function validateConfig(config: RouterConfig): RouterConfig {
  const { host, port } = config.listen ?? {};
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error("listen.host must be a loopback address in this prototype");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("listen.port is invalid");
  for (const [provider, origin] of Object.entries(config.upstreams ?? {})) {
    if (!isProvider(provider)) throw new Error(`unknown upstream provider ${provider}`);
    if (origin !== undefined) parseUpstreamOrigin(origin);
  }
  return config;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateAccounts(accounts: AccountConfig[]): AccountConfig[] {
  const seen = new Set<string>();
  const homes = new Set<string>();
  for (const account of accounts) {
    if (!ACCOUNT_ID.test(account.id)) throw new Error(`invalid account id ${JSON.stringify(account.id)}`);
    if (seen.has(account.id)) throw new Error(`duplicate account id ${account.id}`);
    if (!isProvider(account.provider)) throw new Error(`account ${account.id} has unknown provider`);
    if (typeof account.home !== "string" || !account.home.startsWith("/")) {
      throw new Error(`account ${account.id} home must be an absolute path`);
    }
    if (account.credentialStore !== undefined && account.credentialStore !== "file" && account.credentialStore !== "claude-keychain") {
      throw new Error(`account ${account.id} has unknown credential store`);
    }
    if (account.credentialStore === "claude-keychain" && account.provider !== "claude") {
      throw new Error(`account ${account.id}: claude-keychain requires a Claude account`);
    }
    // Two accounts sharing a home would share one refresh credential.
    const home = resolve(account.home);
    if (homes.has(home)) throw new Error(`account ${account.id} shares a profile home with another account`);
    if (account.helper?.kind === "codex-app-server" && account.provider !== "codex") {
      throw new Error(`account ${account.id}: codex-app-server helper requires a codex account`);
    }
    seen.add(account.id);
    homes.add(home);
  }
  return accounts;
}
