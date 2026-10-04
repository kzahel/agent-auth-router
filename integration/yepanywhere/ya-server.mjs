import "./offline.mjs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, unlinkSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.env.AAR_YA_CHECKOUT;
const load = (path) =>
  import(pathToFileURL(join(checkout, "packages/server/src", path)).href);
const { createApp } = await load("app.ts");
const { SessionMetadataService } = await load(
  "metadata/SessionMetadataService.ts",
);
const providerName = process.env.AAR_TEST_PROVIDER;
const { ClaudeProvider } = await load("sdk/providers/claude.ts");
const { CodexProvider } = await load("sdk/providers/codex.ts");
const provider =
  providerName === "claude"
    ? new ClaudeProvider()
    : new CodexProvider({
        codexPath: process.env.AAR_FAKE_CLI,
        codexHome: process.env.CODEX_HOME,
      });
const start = provider.startSession.bind(provider);
provider.startSession = async (options) => {
  appendFileSync(
    join(process.env.HOME, "launches.jsonl"),
    JSON.stringify({
      provider: providerName,
      routed: !!options.routerLaunch,
      thinking: options.thinking,
      effort: options.effort,
      resume: options.resumeSessionId ?? null,
      metadataId: Object.entries(
        JSON.parse(
          readFileSync(
            join(process.env.YEP_DATA_DIR, "session-metadata.json"),
            "utf8",
          ),
        ).sessions,
      ).find(
        ([, value]) =>
          value.routerBinding?.id === options.routerLaunch?.bindingId,
      )?.[0],
    }) + "\n",
  );
  const failure = join(process.env.HOME, "fail-next-launch");
  if (existsSync(failure)) {
    const offline = readFileSync(failure, "utf8") === "offline";
    unlinkSync(failure);
    if (offline) {
      const acknowledgement = once(process, "message");
      process.send({ event: "stop-router-for-failed-launch" });
      const [reply] = await acknowledgement;
      if (reply.event !== "router-stopped")
        throw new Error("Fault injection handshake failed");
    }
    throw new Error("Synthetic native launch failure");
  }
  return start(options);
};
const metadata = new SessionMetadataService({
  dataDir: process.env.YEP_DATA_DIR,
});
await metadata.initialize();
const instance = createApp({
  provider,
  dataDir: process.env.YEP_DATA_DIR,
  sessionMetadataService: metadata,
  projectsDir: process.env.CLAUDE_SESSIONS_DIR,
  codexSessionsDir: process.env.CODEX_SESSIONS_DIR,
  geminiSessionsDir: join(process.env.HOME, "empty/gemini"),
  grokSessionsDir: join(process.env.HOME, "empty/grok"),
  piSessionsDir: join(process.env.HOME, "empty/pi"),
  authDisabled: true,
  getLatestVersion: async () => null,
});
const require = createRequire(join(checkout, "packages/server/package.json"));
const { getRequestListener } = require("@hono/node-server");
const server = createServer(getRequestListener(instance.app.fetch));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send({ origin: `http://127.0.0.1:${server.address().port}` });
process.once("SIGTERM", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  instance.stopNotifications();
  await instance.supervisor.stopBackgroundTasks();
  await instance.disposeSessionReaders();
  process.exit(0);
});
