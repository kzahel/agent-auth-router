#!/usr/bin/env node
// Local administration is filesystem access to the private state directory;
// there is no network administration surface in this prototype.

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { credentialReaderFor } from "./credentials.ts";
import { generateGatewayToken, hashGatewayToken } from "./gateway-auth.ts";
import { buildCoordinators, startRouter } from "./runtime.ts";
import { defaultStateDir, ensurePrivateDir, StateStore } from "./state.ts";
import { isProvider, PROVIDERS, type AccountConfig, type GatewayClientRecord, type Provider } from "./types.ts";

const USAGE = `usage: aar [--state DIR] <command>

  init                                   create the private state directory
  account add <id> --provider P [--home DIR] [--helper codex-app-server|none]
  account list                           show enrollment and expiry metadata
  account login-command <id>             print the official CLI login command
  renew <id>                             run the renewal helper once and verify
  client add <name> [--claude ACCT] [--codex ACCT]
  client list
  client revoke <id-or-name>
  serve                                  run the router on the configured loopback port

State defaults to $AAR_STATE_DIR or ~/.agent-auth-router.`;

function fail(message: string): never {
  process.stderr.write(`aar: ${message}\n`);
  process.exit(1);
}

function loginCommand(account: AccountConfig): string {
  const home = JSON.stringify(account.home);
  if (account.provider === "codex") {
    return `env -u OPENAI_BASE_URL -u OPENAI_API_KEY -u CODEX_API_KEY CODEX_HOME=${home} codex login`;
  }
  return `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${home} claude auth login`;
}

function clientSnippets(origin: string, token: string, accounts: Partial<Record<Provider, string>>): string {
  const lines: string[] = [];
  if (accounts.claude) {
    lines.push(
      "Claude Code:",
      `  ANTHROPIC_BASE_URL=${origin}/claude ANTHROPIC_AUTH_TOKEN=${token} claude`,
    );
  }
  if (accounts.codex) {
    lines.push(
      "Codex (~/.codex/config.toml or a dedicated client CODEX_HOME):",
      "  model_provider = \"aar\"",
      "  [model_providers.aar]",
      "  name = \"agent-auth-router\"",
      `  base_url = "${origin}/codex"`,
      "  wire_api = \"responses\"",
      "  env_key = \"AAR_TOKEN\"",
      `  # then run with AAR_TOKEN=${token}`,
    );
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      provider: { type: "string" },
      home: { type: "string" },
      helper: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, sub, arg] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const store = new StateStore(values.state ? resolve(values.state) : defaultStateDir());

  switch (command) {
    case "init": {
      store.init();
      process.stdout.write(`state directory: ${store.dir}\n`);
      return;
    }
    case "account": {
      const accounts = store.loadAccounts();
      if (sub === "add") {
        if (!arg) fail("account add requires an id");
        if (!isProvider(values.provider)) fail(`--provider must be one of ${PROVIDERS.join(", ")}`);
        store.init();
        const home = resolve(values.home ?? join(store.profilesDir, arg));
        ensurePrivateDir(home);
        const helperKind = values.helper ?? (values.provider === "codex" ? "codex-app-server" : "none");
        const account: AccountConfig = { id: arg, provider: values.provider, home };
        if (helperKind === "codex-app-server") account.helper = { kind: "codex-app-server" };
        else if (helperKind !== "none") fail("--helper must be codex-app-server or none");
        if (values.provider === "codex" && !existsSync(join(home, "config.toml"))) {
          // Dedicated profile: pin file storage so the reader has a known store.
          writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
        }
        store.saveAccounts([...accounts, account]);
        process.stdout.write(`added ${account.provider} account ${account.id}\nprofile home: ${home}\n\nSign in with the official CLI:\n  ${loginCommand(account)}\n`);
        return;
      }
      if (sub === "list") {
        for (const account of accounts) {
          const result = await credentialReaderFor(account.provider, account.home)();
          const detail =
            result.status === "ok"
              ? `expires ${result.credential.expiresAt ? new Date(result.credential.expiresAt).toISOString() : "unknown"}`
              : result.reason;
          process.stdout.write(`${account.id}\t${account.provider}\t${result.status}\t${detail}\thelper=${account.helper?.kind ?? "none"}\n`);
        }
        return;
      }
      if (sub === "login-command") {
        const account = accounts.find((candidate) => candidate.id === arg) ?? fail(`unknown account ${arg}`);
        process.stdout.write(loginCommand(account) + "\n");
        return;
      }
      fail("account requires add, list or login-command");
    }
    case "renew": {
      // Phase-1 experiment: force one helper run and report what changed,
      // without printing any credential material.
      const id = sub ?? fail("renew requires an account id");
      store.init();
      const coordinators = buildCoordinators(store.loadAccounts(), store.workDir, undefined);
      const coordinator = coordinators.get(id) ?? fail(`unknown account ${id}`);
      const before = await credentialReaderFor(coordinator.account.provider, coordinator.account.home)();
      if (before.status !== "ok") fail(`credential not readable before renewal: ${before.reason}`);
      const renewed = await coordinator.recoverFromUnauthorized(before.credential);
      const status = coordinator.status();
      const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : "unknown");
      process.stdout.write(
        [
          `account: ${id}`,
          `expiry before: ${iso(before.credential.expiresAt)}`,
          `expiry after: ${iso(renewed?.expiresAt)}`,
          `credential replaced: ${renewed ? "yes" : "no"}`,
          `state: ${status.state}`,
          status.lastError ? `last error: ${status.lastError}` : "",
        ]
          .filter(Boolean)
          .join("\n") + "\n",
      );
      if (!renewed) process.exitCode = 2;
      return;
    }
    case "client": {
      const clients = store.loadClients();
      if (sub === "add") {
        if (!arg) fail("client add requires a name");
        if (clients.some((client) => client.name === arg && !client.revokedAt)) fail(`client ${arg} already exists`);
        const accountIds = new Set(store.loadAccounts().map((account) => `${account.provider}:${account.id}`));
        const accounts: Partial<Record<Provider, string>> = {};
        for (const provider of PROVIDERS) {
          const id = values[provider];
          if (id === undefined) continue;
          if (!accountIds.has(`${provider}:${id}`)) fail(`no ${provider} account ${id}`);
          accounts[provider] = id;
        }
        if (!Object.keys(accounts).length) fail("grant at least one of --claude or --codex");
        const token = generateGatewayToken();
        const record: GatewayClientRecord = {
          id: randomUUID(),
          name: arg,
          tokenSha256: hashGatewayToken(token),
          createdAt: new Date().toISOString(),
          accounts,
        };
        store.init();
        store.saveClients([...clients, record]);
        const config = store.loadConfig();
        const origin = `http://${config.listen.host}:${config.listen.port}`;
        process.stdout.write(
          `client ${record.name} (${record.id})\n\nGateway token (shown once, store it securely):\n  ${token}\n\n${clientSnippets(origin, token, accounts)}\n`,
        );
        return;
      }
      if (sub === "list") {
        for (const client of clients) {
          const grants = Object.entries(client.accounts)
            .map(([provider, id]) => `${provider}=${id}`)
            .join(",");
          process.stdout.write(`${client.id}\t${client.name}\t${client.revokedAt ? "revoked" : "active"}\t${grants}\n`);
        }
        return;
      }
      if (sub === "revoke") {
        const matches = clients.filter((client) => !client.revokedAt && (client.id === arg || client.name === arg));
        if (matches.length !== 1) fail(matches.length ? "ambiguous client" : `no active client ${arg}`);
        matches[0]!.revokedAt = new Date().toISOString();
        store.saveClients(clients);
        process.stdout.write(`revoked ${matches[0]!.name}\n`);
        return;
      }
      fail("client requires add, list or revoke");
    }
    case "serve": {
      const router = await startRouter(store);
      const shutdown = () => {
        router.close().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return;
    }
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
