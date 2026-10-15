import { useState } from "react";
import { useApp, useRouterView } from "../app/context.tsx";
import type { TabId } from "../app/Tabs.tsx";
import { ActionButton } from "../components/ActionButton.tsx";
import type { DiagnosticReport } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import styles from "./diagnostics.module.css";

export function Diagnostics({ onNavigate }: { onNavigate(tab: TabId): void }) {
  const { api } = useApp();
  const { overview } = useRouterView();
  const [accountId, setAccountId] = useState("");
  const [filter, setFilter] = useState("");
  const [report, setReport] = useState<DiagnosticReport>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = async (mode: "passive" | "checkLogin" | "refreshUsage") => {
    setPending(true); setCopied(false);
    try { setReport(await api<DiagnosticReport>("diagnostics", { ...(accountId ? { accountId } : {}), ...(mode !== "passive" ? { [mode]: true } : {}) })); }
    finally { setPending(false); }
  };
  const query = filter.toLowerCase();
  const findings = report?.findings.filter(f => `${f.subject} ${f.status} ${f.code} ${f.message}`.toLowerCase().includes(query));
  return (
    <div className={styles.diagnostics}>
      <h3>Diagnostics</h3>
      <p className={ui.hint}>Run diagnostics checks local configuration and cached health. It does not read credentials or contact providers.</p>
      <label className={styles.account}>Account
        <select aria-label="Diagnostic account" value={accountId} onChange={event => setAccountId(event.target.value)}>
          <option value="">All accounts</option>
          {overview?.accounts.map(a => <option key={a.id} value={a.id}>{a.nickname ?? a.id} · {a.provider}</option>)}
        </select>
      </label>
      <div className={ui.actions}>
        <ActionButton disabled={pending} action={() => run("passive")}>Run diagnostics</ActionButton>
        <ActionButton disabled={pending || !accountId} action={() => run("checkLogin")}>Check sign-in</ActionButton>
        <ActionButton disabled={pending || !accountId} action={() => run("refreshUsage")}>Refresh usage</ActionButton>
      </div>
      <p className={ui.hint}>Choose one account for Check sign-in (reads its credential store) or Refresh usage (contacts the provider and may renew credentials through the official CLI). No inference is requested.</p>
      <label className={styles.filter}>Filter diagnostics
        <input value={filter} onChange={event => setFilter(event.target.value)} type="search" />
      </label>
      <p role="status" className={ui.hint}>{pending ? "Checking…" : report ? `${report.mode} · ${report.accountId ?? "all accounts"} · ${new Date(report.at).toLocaleString()}` : "No diagnostic report yet."}</p>
      {report && <>
        <ActionButton action={async () => { await navigator.clipboard.writeText(report.copyText); setCopied(true); }}>Copy report</ActionButton>
        <p className={ui.hint} role="status">{copied ? "Copied sanitized report." : "Copied reports omit local account identifiers, paths and login information."}</p>
        <ul className={styles.findings} aria-label="Diagnostic findings">
          {findings?.map((f, index) => (
            <li key={`${f.subject}:${f.code}:${index}`}>
              <strong className={styles[f.status]}>{f.status.toUpperCase()}</strong>
              <div><span className={styles.subject}>{f.subject} · {f.code}</span><p>{f.message}</p>
                <small className={ui.hint}>Observed {new Date(f.observedAt).toLocaleString()}</small>
                {f.action && ["accounts", "pools", "integrations"].includes(f.action) && <button type="button" onClick={() => onNavigate(f.action as TabId)}>
                  {f.action === "accounts" ? "Open Accounts" : f.action === "pools" ? "Open Pools" : "Open Connections"}
                </button>}
                {f.action === "install-cli" && <p className={ui.hint}>Install the official CLI, then use Accounts → Check installed CLIs.</p>}
              </div>
            </li>
          ))}
        </ul>
        {!findings?.length && <p className={ui.hint}>No matching findings.</p>}
      </>}
    </div>
  );
}
