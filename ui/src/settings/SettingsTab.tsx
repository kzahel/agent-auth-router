import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../app/ConfirmDialog.tsx";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { errorText } from "../lib/format.ts";
import type { RequestCompression } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import styles from "./settings.module.css";

export type TerminalPresentation = "external" | "embedded";
const RETENTION = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "1 year"], ["forever", "Forever"]];

export function SettingsTab({ visible, presentation, onPresentation }: {
  visible: boolean;
  presentation: TerminalPresentation;
  onPresentation(value: TerminalPresentation): void;
}) {
  const { native, web } = useApp();
  return (
    <div className={styles.settings}>
      <HistorySettings visible={visible} />
      <CompressionSettings visible={visible} />
      {native && <AppSettings presentation={presentation} onPresentation={onPresentation} />}
      {web && (
        <div className={styles.group}>
          <h3>This browser</h3>
          <div className={styles.row}><span>Signed in to this router</span><ActionButton id="logout" action={async () => { await web.logout(); location.reload(); }}>Log out</ActionButton></div>
        </div>
      )}
      <RouterSettings />
    </div>
  );
}

// History retention is stored by the router, so the CLI, web and desktop share it.
function HistorySettings({ visible }: { visible: boolean }) {
  const { api } = useApp();
  const [setting, setSetting] = useState<{ value: string; stored: boolean }>();
  const [status, setStatus] = useState("");
  // After a refused change, loading puts the stored value back and keeps the reason in view.
  const load = useCallback(async (report = true) => {
    try {
      const { stored, retentionDays } = await api<{ stored: boolean; retentionDays: number | null }>("history/settings");
      setSetting({ value: retentionDays === null ? "forever" : String(retentionDays), stored });
      if (report) setStatus(stored ? "" : "History is not stored: the router could not open its database.");
    } catch (failure) { setStatus(errorText(failure)); }
  }, [api]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  // A retention set elsewhere (CLI or an older version) stays selectable.
  const custom = setting && !RETENTION.some(([value]) => value === setting.value) ? [[setting.value, `${setting.value} days`]] : [];
  return (
    <div className={styles.group}>
      <h3>History</h3>
      <label className={styles.row}>Keep history
        <select id="retention" value={setting?.value ?? "30"} disabled={setting?.stored === false} onChange={async (event) => {
          const value = event.target.value;
          setSetting(current => ({ stored: current?.stored ?? true, value }));
          try {
            await api("history/set-retention", { retentionDays: value === "forever" ? null : Number(value) });
            setStatus("");
          } catch (failure) { setStatus(errorText(failure)); void load(false); }
        }}>
          {[...custom, ...RETENTION].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <p className={ui.hint}>Charts, requests, sessions and the event log. Older data is deleted daily.</p>
      <p id="retention-status" className={`${ui.hint} ${styles.note}`} role="status">{status}</p>
    </div>
  );
}

// Request compression per provider; off sends bodies upstream as received.
function CompressionSettings({ visible }: { visible: boolean }) {
  const { api } = useApp();
  const [compression, setCompression] = useState<RequestCompression>({ claude: "off", codex: "off" });
  const [status, setStatus] = useState("");
  const load = useCallback(async (report = true) => {
    try {
      const { requestCompression } = await api<{ requestCompression: RequestCompression }>("settings/request-compression");
      setCompression({ claude: requestCompression.claude, codex: requestCompression.codex });
      if (report) setStatus("");
    } catch (failure) { setStatus(errorText(failure)); }
  }, [api]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  const choose = (provider: "claude" | "codex", options: [string, string][]) => (
    <label className={styles.row}>{provider === "claude" ? "Claude" : "Codex"}
      <select id={`compress-${provider}`} value={compression[provider]} onChange={async (event) => {
        const value = event.target.value;
        setCompression(current => ({ ...current, [provider]: value }));
        try {
          await api("settings/request-compression", { provider, value });
          setStatus("");
        } catch (failure) { setStatus(errorText(failure)); void load(false); }
      }}>
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  );
  return (
    <div className={styles.group}>
      <h3>Requests to providers</h3>
      {choose("claude", [["off", "Pass through"], ["gzip", "Compress with gzip"]])}
      {choose("codex", [["off", "Pass through"], ["zstd", "Compress with zstd"]])}
      <p className={ui.hint}>Pass through sends each request as the client sent it. Compressing shrinks uploads about 2–4×.</p>
      <p id="compression-status" className={`${ui.hint} ${styles.note}`} role="status">{status}</p>
    </div>
  );
}

/** Desktop only: sign-in terminal, launch at login and updates. */
function AppSettings({ presentation, onPresentation }: { presentation: TerminalPresentation; onPresentation(value: TerminalPresentation): void }) {
  const { native, router } = useApp();
  const confirm = useConfirm();
  const [startup, setStartup] = useState(false);
  const [update, setUpdate] = useState<string>();
  const [status, setStatus] = useState("");
  const [checking, runCheck] = useAction();
  const job = useRef<Promise<void> | undefined>(undefined);
  const checkUpdate = useCallback(() => (job.current ??= (async () => {
    const result = await native!.checkUpdate();
    setUpdate(result.version);
    setStatus(result.version
      ? `Version ${result.version} is available. Install when your requests and sign-ins have finished.`
      : "You have the latest published version.");
  })().finally(() => { job.current = undefined; })), [native]);
  useEffect(() => {
    native!.startup(null).then(setStartup, (failure: unknown) => router.setError(failure));
    const first = setTimeout(() => { checkUpdate().catch(() => setStatus("Update check unavailable. You can try again manually.")); }, 5000);
    const daily = setInterval(() => { checkUpdate().catch(() => {}); }, 24 * 60 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(daily); };
  }, [native, router, checkUpdate]);
  return (
    <div className={styles.group}>
      <h3>App</h3>
      <label className={styles.row}>Sign-in terminal
        <select id="terminal-presentation" value={presentation} onChange={(event) => onPresentation(event.target.value as TerminalPresentation)}>
          <option value="external">Terminal.app</option>
          <option value="embedded">Built-in terminal</option>
        </select>
      </label>
      <label className={styles.row}>Launch at login
        <input id="startup" type="checkbox" checked={startup} onChange={(event) => {
          const desired = event.target.checked;
          setStartup(desired);
          void router.run(async () => {
            try { setStartup(await native!.startup(desired)); }
            catch (failure) { setStartup(!desired); throw failure; }
          });
        }} />
      </label>
      <div className={styles.row}>
        <span>Updates</span>
        <span className={ui.actions}>
          <button id="check-update" type="button" disabled={checking} onClick={() => void runCheck(checkUpdate)}>Check for updates</button>
          <ActionButton id="install-update" hidden={!update} action={async () => {
            if (!update) return;
            if (!await confirm(`Install ${update} and relaunch? The router must be idle.`, "Install & relaunch")) return;
            setStatus(`Downloading and installing ${update}… The app will relaunch when finished.`);
            try { await native!.installUpdate(update); }
            catch (failure) { setStatus(`Update failed: ${String(failure)}`); throw failure; }
          }}>Install update &amp; relaunch</ActionButton>
        </span>
      </div>
      <p id="update-status" className={styles.updateStatus} role="status">{status}</p>
      <p className={ui.hint}>Closing the window keeps the router running in the menu bar; Quit stops it.</p>
    </div>
  );
}

function RouterSettings() {
  const { api, native, router } = useApp();
  const confirm = useConfirm();
  return (
    <div className={styles.group}>
      <h3>Router</h3>
      <div className={styles.row}>
        <span>Stop routing</span>
        <ActionButton id="stop" danger action={async () => {
          const overview = router.view.overview;
          if (!overview || !await confirm("Stop the router? Idle sessions will be unable to send requests until it is started again. Active requests or sign-ins prevent stopping.")) return;
          router.stoppedByOwner = true;
          try { await api("stop", { routerId: overview.routerId }); }
          catch (failure) { router.stoppedByOwner = false; throw failure; }
          router.setStatus(native ? "Router stopped." : "Router stopped. Start it again with aar serve.", true);
        }}>Stop router</ActionButton>
      </div>
      <p className={ui.hint}>{native ? "Start router in the status bar starts it again." : <>Start it again with <code>aar serve</code>.</>}</p>
    </div>
  );
}
