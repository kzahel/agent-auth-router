import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { AppProvider } from "./app/context.tsx";
import { RouterState } from "./app/router-state.ts";
import { AppClient, tauriPort, webSocketPort, type WebPort } from "./protocol/client.ts";

// The desktop relays the core's private socket; the browser uses the web
// dashboard's WebSocket after signing in with its one-time link.
const desktop = !!window.__TAURI__;
const port = desktop ? await tauriPort() : webSocketPort();
const client = new AppClient(port);
const router = new RouterState(client, desktop);
let signedOut: string | undefined;
if (!desktop) {
  const session = await (port as WebPort).authenticate();
  if (!session.authenticated) {
    signedOut = session.error ?? "This browser is not signed in.";
    router.setStatus("");
  }
}
if (client.shell.native) void client.shell.onLifecycleError((payload) => { router.setError(payload); router.setStatus("Router could not stop"); });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider client={client} router={router}><App signedOut={signedOut} /></AppProvider>
  </StrictMode>,
);
// The first load may start a stopped desktop core; reconnection never does.
if (signedOut === undefined) void router.run(() => router.reload(true));
