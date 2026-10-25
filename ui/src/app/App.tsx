import { useState, type ReactNode } from "react";
import { AccountsTab } from "../accounts/AccountsTab.tsx";
import { ConnectionsTab } from "../connections/ConnectionsTab.tsx";
import { PanelBoundary } from "../components/PanelBoundary.tsx";
import { ActionButton } from "../components/ActionButton.tsx";
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
export function App({ signedOut, loginCommand = "aar dashboard url" }: { signedOut?: string | undefined; loginCommand?: string | undefined }) {
  const { native, router } = useApp();
  const { overview, access } = useRouterView();
  const readOnly = !native && access === "viewer";
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
        <CrashBanner readOnly={readOnly} />
        {signedOut !== undefined ? (
          <section id="signed-out" className={styles.signedOut}>
            <SignInGuide command={loginCommand} detail={signedOut} />
          </section>
        ) : (
          <div id="app-shell">
            {readOnly && <p className={styles.viewOnly}>View only · <button type="button" onClick={() => setTab("settings")}>Sign in to manage</button></p>}
            <Tabs selected={tab} onSelect={setTab} />
            <ErrorLine />
            {panel("dashboard", <DashboardTab visible={tab === "dashboard"} onAddAccount={() => setTab("accounts")} />)}
            {panel("accounts", readOnly ? <SignInGuide command={loginCommand} manage /> : <AccountsTab presentation={presentation} />)}
            {panel("pools", readOnly ? <SignInGuide command={loginCommand} manage /> : <PoolsTab />)}
            {panel("integrations", readOnly ? <SignInGuide command={loginCommand} manage /> : <ConnectionsTab />)}
            {panel("settings", readOnly ? <SignInGuide command={loginCommand} manage /> : <SettingsTab visible={tab === "settings"} presentation={presentation} onPresentation={setPresentation} onNavigate={setTab} />)}
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

function SignInGuide({ command, detail, manage }: { command: string; detail?: string; manage?: boolean }) {
  return (
    <div className={styles.signedOut}>
      <h2>{manage ? "Sign in to manage the router" : "Sign in to the dashboard"}</h2>
      {detail && <p id="signed-out-detail" className={ui.hint}>{detail}</p>}
      <p className={ui.hint}>Run this command in a terminal on the computer running the router:</p>
      <pre className={styles.loginCommand}><code>{command}</code></pre>
      <div><ActionButton action={() => navigator.clipboard.writeText(command)}>Copy command</ActionButton></div>
      <p className={ui.hint}>Open the link it prints in this browser to sign in. Each link signs in one browser. You can also use the sign-in link printed by <code>aar serve</code>.</p>
    </div>
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

/** The latest unacknowledged crash stays visible until the owner dismisses it. */
function CrashBanner({ readOnly }: { readOnly: boolean }) {
  const { api, native, router } = useApp();
  const { overview } = useRouterView();
  const [pending, run] = useAction();
  const crashes = overview?.crashes ?? [];
  const latest = crashes.at(-1);
  if (!latest) return null;
  const earlier = crashes.length - 1;
  return (
    <div id="crash" className={styles.crashBanner} role="alert">
      <div>
        <strong>The router crashed at {new Date(latest.at).toLocaleString()}</strong>
        {earlier > 0 && <span> (and {earlier} earlier {earlier === 1 ? "time" : "times"})</span>}
        <div id="crash-message" className={styles.crashDetail}>{latest.message}{latest.frame && <> · {latest.frame}</>}</div>
        <div className={styles.crashDetail}>{native ? <>Details: <code>crashes.json</code> in the router's state folder</> : <>Details: <code>aar logs --crashes</code></>}</div>
      </div>
      {!readOnly && <button id="dismiss-crash" type="button" disabled={pending} onClick={() => void run(async () => {
        await api("crashes/acknowledge", { id: latest.id });
        await router.reload();
      })}>Dismiss</button>}
    </div>
  );
}

function ErrorLine() {
  const { error } = useRouterView();
  return <p id="error" className={styles.error} role="alert" hidden={!error}>{error}</p>;
}
