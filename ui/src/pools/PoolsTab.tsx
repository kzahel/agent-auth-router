import { useState } from "react";
import { useRouterView } from "../app/context.tsx";
import { accountLabel } from "../lib/accounts.ts";
import type { Pool } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import { PoolEditor } from "./PoolEditor.tsx";
import styles from "./pools.module.css";

export const POLICY_LABELS: Record<string, string> = {
  manual: "Manual",
  "round-robin": "Round robin",
  "most-remaining": "Most remaining",
  "weekly-pace": "Weekly pace",
};

export function PoolsTab() {
  const { overview } = useRouterView();
  // Each Edit pool or Create pool opens a fresh editor.
  const [editing, setEditing] = useState<{ pool: Pool | undefined; opened: number }>();
  const edit = (pool?: Pool) => setEditing(current => ({ pool, opened: (current?.opened ?? 0) + 1 }));
  const pools = overview?.pools ?? [];
  return (
    <>
      <div className={ui.sectionHeading}>
        <h2>Pools</h2>
        <button id="new-pool" type="button" onClick={() => { if (overview) edit(); }}>Create pool</button>
      </div>
      <div id="pools" className={ui.cards}>
        {pools.map(p => (
          <article key={p.id} className={`${ui.card} ${styles.card}`}>
            <h3>{p.name}</h3>
            <p className={ui.badge}>{`${p.provider} · ${POLICY_LABELS[p.policy] ?? "Unsupported policy"} · ${p.accountIds.length} accounts`}</p>
            <p className={`${ui.hint} ${ui.profilePath}`}>{p.accountIds.map(id => accountLabel(overview?.accounts.find(a => a.id === id) ?? { id })).join(", ")}</p>
            <button type="button" onClick={() => edit(p)}>Edit pool</button>
          </article>
        ))}
        {!pools.length && <p className={ui.hint}>No pools</p>}
      </div>
      {editing && overview && <PoolEditor key={editing.opened} pool={editing.pool} overview={overview} onClose={() => setEditing(undefined)} />}
    </>
  );
}
