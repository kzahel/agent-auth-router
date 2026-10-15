import { useState } from "react";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import { CheckList } from "../components/CheckList.tsx";
import { accountLabel } from "../lib/accounts.ts";
import type { Integration, Overview } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";

/** Chooses the pools and accounts one connection may use; choices survive router updates. */
export function GrantEditor({ integration, overview, onClose }: { integration: Integration; overview: Overview; onClose(): void }) {
  const { api, router } = useApp();
  const [pools, setPools] = useState<ReadonlySet<string>>(new Set(integration.poolIds));
  const [accounts, setAccounts] = useState<ReadonlySet<string>>(new Set(integration.accountIds));
  const [saving, save] = useAction();
  return (
    <form id="grant-form" onSubmit={(event) => {
      event.preventDefault();
      void save(async () => {
        await api("grants/save", { id: integration.id, revision: integration.revision, poolIds: [...pools], accountIds: [...accounts] });
        onClose();
        await router.reload();
      });
    }}>
      <h3>{`Access for ${integration.name}`}</h3>
      <fieldset>
        <legend>Pool access</legend>
        <CheckList id="grant-pools" selected={pools} onChange={setPools} items={overview.pools.map(p => ({ value: p.id, label: `${p.name} · ${p.provider}` }))} />
      </fieldset>
      <fieldset>
        <legend>Direct account access (legacy/manual)</legend>
        <CheckList id="grant-accounts" selected={accounts} onChange={setAccounts} items={overview.accounts.map(a => ({ value: a.id, label: accountLabel(a) }))} />
      </fieldset>
      <p className={ui.hint}>Removing access blocks subsequent requests on affected sessions. Accepted streams may finish.</p>
      <div className={ui.actions}>
        <button type="submit" disabled={saving}>Save access</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
