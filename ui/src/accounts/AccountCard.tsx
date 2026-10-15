import { useRef, useState, type ReactNode } from "react";
import { useConfirm } from "../app/ConfirmDialog.tsx";
import { useApp } from "../app/context.tsx";
import { ActionButton } from "../components/ActionButton.tsx";
import type { Account, LoginStatus } from "../protocol/types.ts";
import type { TerminalPresentation } from "../settings/SettingsTab.tsx";
import ui from "../styles/ui.module.css";
import styles from "./accounts.module.css";

// An expired access token is not a lost login; only a failed renewal or a
// missing refresh token needs the user to sign in again.
const SIGN_IN_LABELS: Record<string, string> = {
  ready: "Signed in",
  idle: "Signed in · access token renews on next use",
  renewing: "Renewing through the official CLI",
  renewal_failed: "Renewal failed — refresh usage to retry, or sign in again",
  login_required: "Sign in again",
  signed_out: "Not signed in",
  unusable: "Stored credentials unreadable",
};

/**
 * One enrolled account: its quota windows and actions. Sign in, Refresh
 * usage and Cancel sign-in stay in view; the rest sit under More.
 */
export function AccountCard({ account: a, login, presentation, onEditNickname, onRemove }: {
  account: Account;
  login: { status: string } | undefined;
  presentation: TerminalPresentation;
  onEditNickname(): void;
  onRemove(): Promise<void>;
}) {
  const { api, native, router } = useApp();
  const confirm = useConfirm();
  const [command, setCommand] = useState<string>();
  const [notes, setNotes] = useState<ReactNode[]>([]);
  const more = useRef<HTMLDetailsElement>(null);

  const signIn = async () => {
    if (native) {
      await native.terminalLogin(a.id, presentation);
      await router.reload();
      return;
    }
    // A browser cannot open a terminal on the router's machine: show the official command.
    setCommand((await api<{ command: string }>("accounts/login-command", { id: a.id })).command);
  };
  const checkSignIn = async () => {
    const s = await api<LoginStatus>("accounts/login-status", { id: a.id });
    setNotes(notes => [...notes,
      <p key={notes.length} className={ui.hint}>{`${SIGN_IN_LABELS[s.signIn] ?? `Sign-in: ${s.signIn}`} · sign-in ${s.loginStatus}`}</p>,
      ...(s.canOpenLogin ? [<ActionButton key={`${notes.length}-open`} action={() => api("accounts/open-login", { id: a.id })}>Open sign-in page</ActionButton>] : [])]);
  };
  const setEnabled = async () => {
    if (a.enabled && !await confirm(`Disable ${a.id}? ${a.bindingCount ?? 0} session pins reference this account. New requests on its session pins will be blocked. Accepted streams may finish. Credentials will be kept.`)) return;
    await api("accounts/set-enabled", { id: a.id, revision: a.revision, enabled: !a.enabled });
    await router.reload();
  };
  const remove = <ActionButton danger action={onRemove}>Remove</ActionButton>;
  const cancelSignIn = login?.status === "running" && (
    <ActionButton action={async () => { await api("accounts/cancel-login", { id: a.id }); await router.reload(); }}>Cancel sign-in</ActionButton>
  );

  return (
    <article className={ui.card}>
      <h3 className={ui.profilePath}>{a.home ?? a.id}</h3>
      {a.nickname && <p className={styles.nickname}>{a.nickname}</p>}
      <span className={ui.badge}>{`${a.provider} · ${a.retired ? "retired" : a.enabled ? "enabled" : "disabled"} · usage ${a.freshness}`}</span>
      {a.windows.map(w => (
        <div key={w.bucket} className={styles.quota}>
          <span>{`${w.bucket} · ${w.remainingPercent == null ? "Remaining unknown" : `${w.remainingPercent}% left`}`}</span>
          <progress max={100} value={w.remainingPercent ?? undefined} aria-label={`${w.bucket} remaining`} />
          <small>{`${w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : "Reset time unknown"} · scope: ${w.scope}`}</small>
        </div>
      ))}
      {!a.windows.length && <p className={ui.hint}>Quota not checked</p>}
      {(a.error || a.blocked) && <p className={ui.unknown}>{a.blocked ?? a.error}</p>}
      {login && <p className={ui.hint}>{`Sign-in: ${login.status}`}</p>}
      {command && (
        <div className={styles.loginCommand}>
          <p className={ui.hint}>Run this in a terminal on the router's machine, then choose Check sign-in:</p>
          <pre>{command}</pre>
          <ActionButton action={() => navigator.clipboard.writeText(command)}>Copy command</ActionButton>
        </div>
      )}
      <div className={ui.actions}>
        {a.retired ? (
          <>
            <span className={ui.hint}>Retired · credential profile retained</span>
            {remove}
            {cancelSignIn}
          </>
        ) : (
          <>
            <ActionButton action={signIn}>Sign in</ActionButton>
            <ActionButton action={async () => { await api("accounts/refresh", { id: a.id }); await router.reload(); }}>Refresh usage</ActionButton>
            {cancelSignIn}
            <details ref={more} className={styles.more}>
              <summary>More</summary>
              {/* Choosing one of these actions folds the group again. */}
              <div className={ui.actions} onClick={(event) => { if (event.target instanceof HTMLButtonElement && more.current) more.current.open = false; }}>
                <ActionButton action={checkSignIn}>Check sign-in</ActionButton>
                <ActionButton action={onEditNickname}>Edit nickname</ActionButton>
                <ActionButton danger={a.enabled} action={setEnabled}>{a.enabled ? "Disable" : "Enable"}</ActionButton>
                {remove}
              </div>
            </details>
          </>
        )}
      </div>
      {notes}
    </article>
  );
}
