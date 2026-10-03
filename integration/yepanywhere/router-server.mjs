import "./offline.mjs";
import { startRouter } from "../../src/runtime.ts";
import { StateStore } from "../../src/state.ts";
const router = await startRouter(new StateStore(process.env.AAR_STATE_DIR));
process.send({ origin: router.origin, socket: router.controlSocket });
process.once("SIGTERM", async () => {
  await router.close();
  process.exit(0);
});
