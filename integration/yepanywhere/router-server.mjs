import "./offline.mjs";
import { fileURLToPath } from "node:url";
import { startRouter } from "../../src/runtime.ts";
import { StateStore } from "../../src/state.ts";
const store = new StateStore(process.env.AAR_STATE_DIR);
const router = await startRouter(store, {
  claudeOrigin: store.loadConfig().upstreams?.claude,
  codexCommand: process.execPath,
  codexArgs: [fileURLToPath(new URL("./fake-quotas.mjs", import.meta.url))],
});
process.send({ origin: router.origin, socket: router.controlSocket });
process.once("SIGTERM", async () => {
  await router.close();
  process.exit(0);
});
