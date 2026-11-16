import { useRouterView } from "../app/context.tsx";
import { accountName, allResets, resetUrgency, URGENCY_LABEL, type AccountReset, type ResetUrgency } from "../lib/resets.ts";
import ui from "../styles/ui.module.css";
import { ExpiryBadge } from "./ExpiryBadge.tsx";
import styles from "./resets.module.css";
import { useNow } from "./use-now.ts";

const ORDER: ResetUrgency[] = ["expired", "day", "week", "fortnight", "later", "unknown"];

/**
 * Every account's unused limit resets, grouped by how soon they expire, so
 * the ones about to lapse stand out. Each names its account, which opens it.
 */
export function ResetsTab({ visible, onOpenAccount, onOpenSettings }: { visible: boolean; onOpenAccount(id: string): void; onOpenSettings(): void }) {
  const { overview } = useRouterView();
  const now = useNow(visible);
  const accounts = overview?.accounts ?? [];
  const read = accounts.filter(a => a.quota?.limitResets);
  if (!read.length) {
    return (
      <div className={styles.unknown}>
        <p className={ui.hint}>No limit resets have been read. Turn on Show limit resets in Settings, then refresh usage on the Accounts tab.</p>
        <div><button type="button" onClick={onOpenSettings}>Open Settings</button></div>
      </div>
    );
  }
  const rows = allResets(accounts);
  const groups = ORDER.map(urgency => ({ urgency, rows: rows.filter(r => resetUrgency(r.expiresAt, now) === urgency) })).filter(g => g.rows.length);
  const unknown = read.filter(a => a.quota!.limitResets!.error);
  return (
    <div id="resets">
      {!rows.length && <p className={ui.hint}>No unused limit resets.</p>}
      {groups.map(g => (
        <div key={g.urgency} className={styles.group}>
          <h3>{URGENCY_LABEL[g.urgency]} <span className={ui.badge}>{g.rows.reduce((sum, r) => sum + r.available, 0)}</span></h3>
          <ul className={styles.list}>
            {g.rows.map((r, i) => <ResetRow key={`${r.account.id}-${i}`} reset={r} now={now} onOpenAccount={onOpenAccount} />)}
          </ul>
        </div>
      ))}
      {!!unknown.length && (
        <div className={styles.unknown}>
          <h3>Not known</h3>
          {unknown.map(a => (
            <p key={a.id} className={ui.unknown}>
              <button type="button" className={styles.account} onClick={() => onOpenAccount(a.id)}>{accountName(a)}</button>{`: ${a.quota!.limitResets!.error}`}
            </p>
          ))}
        </div>
      )}
      <p className={`${ui.hint} ${styles.group}`}>Resets are read with each usage check. The router never uses one.</p>
    </div>
  );
}

function ResetRow({ reset: r, now, onOpenAccount }: { reset: AccountReset; now: number; onOpenAccount(id: string): void }) {
  const left = r.available > 1 || (r.total ?? 0) > 1 ? ` · ${r.available}${r.total ? ` of ${r.total}` : ""} left` : "";
  return (
    <li className={styles.row} data-urgency={resetUrgency(r.expiresAt, now)}>
      <ExpiryBadge expiresAt={r.expiresAt} now={now} />
      <span className={styles.what}>
        <span>{`${r.label ?? "Reset"}${left}`}</span>
        <small>{[r.expiresAt ? `Expires ${new Date(r.expiresAt).toLocaleString()}` : "No expiry reported", ...(r.usableNow === false ? ["not usable now"] : [])].join(" · ")}</small>
      </span>
      <button type="button" className={styles.account} title={`Open ${r.account.nickname ?? r.account.id} on the Accounts tab`}
        onClick={() => onOpenAccount(r.account.id)}>{`${accountName(r.account)} · ${r.account.provider}`}</button>
    </li>
  );
}
