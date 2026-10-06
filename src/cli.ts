#!/usr/bin/env node
// Local administration shares the running owner service over private IPC.

import { desktopStartupError } from "./desktop-lifecycle.ts";
import { stopManagedProcesses } from "./process.ts";
import { terminalLogin } from "./terminal-login.ts";
import { loginCommand, ownerRequest } from "./owner.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { credentialReaderFor } from "./credentials.ts";
import { generateGatewayToken, hashGatewayToken } from "./gateway-auth.ts";
import { DEFAULT_DASHBOARD_PORT } from "./dashboard.ts";
import { fetchAccountQuotas } from "./quotas.ts";
import { startRouter } from "./runtime.ts";
import { defaultStateDir, StateStore } from "./state.ts";
import { isProvider, PROVIDERS, type GatewayClientRecord, type Provider } from "./types.ts";

const USAGE = `usage: aar [--state DIR] <command>

  init                                   create the private state directory
  account add <id> --provider P [--home DIR] [--helper codex-app-server|claude-cli|none]
                  [--credential-store file|claude-keychain]
  account list                           show enrollment and expiry metadata
  owner <operation>                      administer via the router; JSON on stdin
  account quotas [id]                    fetch quota percentages and reset times (JSON)
  account login-command <id>             print the official CLI login command
  renew <id>                             run the renewal helper once and verify
  client add <name> [--claude ACCT] [--codex ACCT]
  client list
  client revoke <id-or-name>
  serve [--dashboard-port N] [--no-dashboard] [--dev]
                                         run the router on the configured loopback port,
                                         with the web dashboard on 127.0.0.1:${DEFAULT_DASHBOARD_PORT};
                                         --dev reloads browsers when UI files change
  dashboard url                          print a new single-use dashboard access link
  dashboard sessions                     list signed-in dashboard browsers
  dashboard revoke <session-id>|--all    sign out dashboard browsers

State defaults to $AAR_STATE_DIR or ~/.agent-auth-router. The dashboard port can
also be set with $AAR_DASHBOARD_PORT.`;

function fail(message: string): never {
  process.stderr.write(`aar: ${message}\n`);
  process.exit(1);
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
      "credential-store": { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      "dashboard-port": { type: "string" },
      "no-dashboard": { type: "boolean" },
      dev: { type: "boolean" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, sub, arg] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  const store = new StateStore(values.state ? resolve(values.state) : defaultStateDir());

  // Live and offline writes use the same socket owner. Offline administration
  // briefly starts the core; socket ownership prevents a competing writer.
  const administer = async (operation: string, body: object) => {
    if (existsSync(join(store.dir, "control.sock"))) return ownerRequest(store, operation, body);
    if (operation === "accounts/login") throw new Error("Start aar serve or the desktop app before starting an interactive login");
    const router = await startRouter(store);
    try { return await ownerRequest(store, operation, body); } finally { await router.close(); }
  };

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
        const credentialStore = values["credential-store"];
        if (credentialStore !== undefined && credentialStore !== "file" && credentialStore !== "claude-keychain") {
          fail("--credential-store must be file or claude-keychain");
        }
        if (credentialStore === "claude-keychain" && (values.provider !== "claude" || process.platform !== "darwin")) {
          fail("claude-keychain requires a Claude account on macOS");
        }
        const home = resolve(values.home ?? join(store.profilesDir, arg));
        await administer("accounts/add", { id: arg, provider: values.provider, home, ...(credentialStore ? { credentialStore } : {}), ...(values.helper ? { helper: values.helper } : {}) });
        const account = store.loadAccounts().find(a => a.id === arg)!;
        process.stdout.write(`added ${account.provider} account ${account.id}\nprofile home: ${home}\n\nSign in with the official CLI:\n  ${loginCommand(account)}\n`);
        return;
      }
      if (sub === "list") {
        for (const account of accounts) {
          const result = await credentialReaderFor(account.provider, account.home, account.credentialStore)();
          const detail =
            result.status === "ok"
              ? `expires ${result.credential.expiresAt ? new Date(result.credential.expiresAt).toISOString() : "unknown"}`
              : result.reason;
          process.stdout.write(`${account.id}\t${account.provider}\t${result.status}\t${detail}\thelper=${account.helper?.kind ?? (account.provider === "claude" ? "claude-cli" : "none")}\n`);
        }
        return;
      }
      if (sub === "login-command") {
        const account = accounts.find((candidate) => candidate.id === arg) ?? fail(`unknown account ${arg}`);
        process.stdout.write(loginCommand(account) + "\n");
        return;
      }
      if (sub === "quotas") {
        const selected = arg ? [accounts.find((account) => account.id === arg) ?? fail(`unknown account ${arg}`)] : accounts;
        store.init();
        const snapshots = [];
        for (const account of selected) snapshots.push(await fetchAccountQuotas(account, store.workDir));
        process.stdout.write(JSON.stringify(snapshots, null, 2) + "\n");
        if (snapshots.some((snapshot) => snapshot.status !== "ok")) process.exitCode = 2;
        return;
      }
      fail("account requires add, list, quotas or login-command");
    }
    case "terminal-login":
      if (!sub) fail("terminal-login requires an account id");
      await terminalLogin(store, sub);
      return;
    case "owner-request":
    case "owner": {
      if (!sub) fail("owner requires an operation (for example overview or pools/save); JSON body on stdin");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 16_384) fail("owner request too large"); chunks.push(Buffer.from(chunk)); }
      const input = Buffer.concat(chunks).toString();
      const result = await (command === "owner-request" ? ownerRequest(store, sub, input.trim() ? JSON.parse(input) : {}) : administer(sub, input.trim() ? JSON.parse(input) : {}));
      process.stdout.write(JSON.stringify(result) + "\n"); return;
    }
    case "renew": {
      const id = sub ?? fail("renew requires an account id");
      const result = await administer("accounts/renew", { id });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n"); if (!result.replaced) process.exitCode = 2; return;
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
        await administer("clients/add", { record });
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
        await administer("clients/revoke", { id: matches[0]!.id });
        process.stdout.write(`revoked ${matches[0]!.name}\n`);
        return;
      }
      fail("client requires add, list or revoke");
    }
    case "dashboard": {
      if (!existsSync(join(store.dir, "control.sock"))) fail("the router is not running; start it with aar serve");
      if (sub === "url") {
        const { url, expiresAt } = await ownerRequest(store, "dashboard/code", {});
        process.stdout.write(`${url}\n(single use; expires ${expiresAt})\n`);
        return;
      }
      if (sub === "sessions") {
        const { sessions } = await ownerRequest(store, "dashboard/sessions", {});
        for (const s of sessions) process.stdout.write(`${s.id}\tcreated ${s.createdAt}\tlast used ${s.lastUsedAt}\t${s.userAgent ?? ""}\n`);
        if (!sessions.length) process.stdout.write("no dashboard sessions\n");
        return;
      }
      if (sub === "revoke") {
        if (!arg && !values.all) fail("dashboard revoke requires a session id or --all");
        const { revoked } = await ownerRequest(store, "dashboard/revoke", values.all ? {} : { id: arg });
        process.stdout.write(`revoked ${revoked} session${revoked === 1 ? "" : "s"}\n`);
        return;
      }
      fail("dashboard requires url, sessions or revoke");
    }
    case "serve":
    case "desktop-serve": {
      const desktop = command === "desktop-serve";
      // The desktop app uses its private socket; only the CLI opens the web dashboard.
      let dashboard: { port: number; dev?: boolean } | undefined;
      if (!desktop && !values["no-dashboard"]) {
        const raw = values["dashboard-port"] ?? process.env.AAR_DASHBOARD_PORT;
        if (raw !== undefined && (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535)) fail("dashboard port must be a number from 0 to 65535");
        // A test configuration with an ephemeral inference port gets an ephemeral dashboard too.
        dashboard = { port: raw !== undefined ? Number(raw) : store.loadConfig().listen.port === 0 ? 0 : DEFAULT_DASHBOARD_PORT, dev: values.dev === true };
      }
      let parentClosed = false;
      let router: Awaited<ReturnType<typeof startRouter>> | undefined;
      let stopping = false;
      const shutdown = () => {
        parentClosed = true;
        // Ctrl-C under npm arrives twice (from the terminal and forwarded by
        // npm). Repeats must not interrupt cleanup and strand the sockets.
        if (!router || stopping) return;
        stopping = true;
        void router.close(true).then(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
      };
      if (desktop) {
        // The app holds this private pipe open. EOF also covers app crashes.
        process.stdin.on("end", shutdown);
        process.stdin.resume();
      }
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      try { router = await startRouter(store, {}, { desktop, recoverStaleSocket: true, cancelProcesses: stopManagedProcesses, onClosed: () => process.exit(0), ...(dashboard ? { dashboard } : {}) }); }
      catch (error) {
        if (desktop) { process.stderr.write(`AAR_STARTUP_ERROR:${JSON.stringify({ message: desktopStartupError(error) })}\n`); process.exit(1); }
        throw error;
      }
      if (router.dashboard) {
        process.stdout.write(`Web dashboard: ${router.dashboard.mintCode().url}\n  This link signs in one browser. Run \`aar dashboard url\` for another.\n`);
        if (dashboard?.dev) process.stdout.write("  Dev mode: signed-in browsers reload when desktop/ui files change.\n");
      }
      if (parentClosed) shutdown();
      return;
    }
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
