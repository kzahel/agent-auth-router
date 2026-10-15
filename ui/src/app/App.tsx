import { useState, type ReactNode } from "react";
import { AccountsTab } from "../accounts/AccountsTab.tsx";
import { ConnectionsTab } from "../connections/ConnectionsTab.tsx";
import { PanelBoundary } from "../components/PanelBoundary.tsx";
import { DashboardTab } from "../dashboard/DashboardTab.tsx";
import { PoolsTab } from "../pools/PoolsTab.tsx";
import { SettingsTab, type TerminalPresentation } from "../settings/SettingsTab.tsx";
import ui from "../styles/ui.module.css";
import styles from "./app.module.css";
import { ConfirmProvider } from "./ConfirmDialog.tsx";
import { useApp, useRouterView } from "./context.tsx";
import { Tabs, type TabId } from "./Tabs.tsx";
import { useAction } from "./use-action.ts";
import { useLocalStorage } from "./use-local-storage.ts";

/**
 * One UI for both shells: the desktop relays the core's private socket, the
 * browser uses the web dashboard's WebSocket. `signedOut` carries why a
 * browser is not signed in.
 */
export function App({ signedOut }: { signedOut?: string | undefined }) {
  const { native, router } = useApp();
  const { overview } = useRouterView();
  const [tab, setTab] = useState<TabId>("dashboard");
  const [presentation, setPresentation] = useLocalStorage<TerminalPresentation>("terminal-presentation", stored => stored === "embedded" ? "embedded" : "external");
  const panel = (id: TabId, content: ReactNode) => (
    <section id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={tab !== id}><PanelBoundary>{content}</PanelBoundary></section>
  );
  // Unbundled routers (run from source) have no version to show.
  const version = overview?.build?.source === "unbundled" ? "" : overview?.build?.version ?? "";
  return (
    <ConfirmProvider>
      <main>
        <header><h1>Agent Auth Router</h1></header>
        <StatusBanner />
        {signedOut !== undefined ? (
          <section id="signed-out" className={styles.signedOut}>
            <h2>Sign in to the dashboard</h2>
            <p id="signed-out-detail" className={ui.hint}>{signedOut}</p>
            <p className={ui.hint}>Open the link that <code>aar serve</code> printed, or run <code>aar dashboard url</code> on this machine for a new one. Each link signs in one browser.</p>
          </section>
        ) : (
          <div id="app-shell">
            <Tabs selected={tab} onSelect={setTab} />
            <ErrorLine />
            {panel("dashboard", <DashboardTab visible={tab === "dashboard"} onAddAccount={() => setTab("accounts")} />)}
            {panel("accounts", <AccountsTab presentation={presentation} />)}
            {panel("pools", <PoolsTab />)}
            {panel("integrations", <ConnectionsTab />)}
            {panel("settings", <SettingsTab visible={tab === "settings"} presentation={presentation} onPresentation={setPresentation} />)}
          </div>
        )}
        <footer>
          {/* The desktop WebView would navigate itself; the shell opens the browser instead. */}
          <a id="project-link" href="https://github.com/kzahel/agent-auth-router" target="_blank" rel="noopener noreferrer"
            onClick={native ? (event) => { event.preventDefault(); native.openProject().catch((failure: unknown) => router.setError(failure)); } : undefined}>
            Agent Auth Router on GitHub
          </a>
          <span id="version">{version}</span>
        </footer>
      </main>
    </ConfirmProvider>
  );
}

function StatusBanner() {
  const { router } = useApp();
  const { status } = useRouterView();
  const [pending, run] = useAction();
  return (
    <div id="status" className={styles.statusBanner} role="status" hidden={!status.message}>
      <span id="status-text">{status.message}</span>
      {status.startable && <button id="start-router" type="button" disabled={pending} onClick={() => void run(() => router.reload(true))}>Start router</button>}
    </div>
  );
}

function ErrorLine() {
  const { error } = useRouterView();
  return <p id="error" className={styles.error} role="alert" hidden={!error}>{error}</p>;
}
