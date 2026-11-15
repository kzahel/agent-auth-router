import { useState } from "react";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { CheckList } from "../components/CheckList.tsx";
import { ago } from "../lib/format.ts";
import type { Overview } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";

/**
 * Approves a device pairing over the public origin, such as another
 * machine's Yep Anywhere. The owner types the code the device shows and
 * chooses its pool access in the same step; waiting devices are listed
 * without their codes so an unexpected request cannot be approved by a click.
 */
export function PairDevice({ overview }: { overview: Overview }) {
  const { api, router } = useApp();
  const [code, setCode] = useState("");
  const [pools, setPools] = useState<ReadonlySet<string>>(new Set());
  const [approved, setApproved] = useState<string>();
  const [saving, save] = useAction();
  const pairings = overview.pairings ?? [];
  if (!overview.publicOrigin && !pairings.length) return null;
  return (
    <>
      <form id="pair-form" className={ui.card} onSubmit={(event) => {
        event.preventDefault();
        void save(async () => {
          const result = await api("pairings/approve", { userCode: code, poolIds: [...pools] }) as { name: string };
          setApproved(result.name);
          setCode("");
          setPools(new Set());
          await router.reload();
        });
      }}>
        <h3>Pair a device</h3>
        <p className={ui.hint}>
          {overview.publicOrigin
            ? `To pair another machine, enter ${overview.publicOrigin} in its Yep Anywhere, then type the code it shows.`
            : "Type the code the pairing device shows."}
        </p>
        <label>
          Code
          <input name="userCode" value={code} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" maxLength={16}
            onChange={(event) => { setCode(event.target.value); setApproved(undefined); }} />
        </label>
        <fieldset>
          <legend>Pool access</legend>
          <CheckList id="pair-pools" selected={pools} onChange={setPools} items={overview.pools.map(p => ({ value: p.id, label: `${p.name} · ${p.provider}` }))}
            empty={<p className={ui.hint}>No pools yet. The device pairs with no access until you grant some.</p>} />
        </fieldset>
        <div className={ui.actions}>
          <button type="submit" disabled={saving || !code.trim()}>Approve</button>
        </div>
        {approved && <p className={ui.hint} role="status">{`Paired ${approved}.`}</p>}
      </form>
      {pairings.length > 0 && (
        <div id="pending-pairings" className={ui.cards}>
          {pairings.map(p => (
            <article key={p.id} className={ui.card}>
              <h3>{p.name}</h3>
              <p className={ui.badge}>{`Waiting to pair · from ${p.address ?? "unknown address"} · ${ago(Date.parse(p.createdAt))}`}</p>
              <div className={ui.actions}>
                <ActionButton danger action={async () => { await api("pairings/deny", { id: p.id }); await router.reload(); }}>Deny</ActionButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
