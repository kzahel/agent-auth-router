import { useState } from "react";
import { useConfirm } from "../app/ConfirmDialog.tsx";
import { useApp, useRouterView } from "../app/context.tsx";
import { ActionButton } from "../components/ActionButton.tsx";
import type { Integration } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import { GrantEditor } from "./GrantEditor.tsx";

/** Apps paired with the router, such as Yep Anywhere, and what each may use. */
export function ConnectionsTab() {
  const { api, router } = useApp();
  const { overview } = useRouterView();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ integration: Integration; opened: number }>();
  const integrations = overview?.integrations ?? [];
  return (
    <>
      <div className={ui.sectionHeading}><h2>Connections</h2></div>
      <div id="integrations" className={ui.cards}>
        {integrations.map(i => (
          <article key={i.id} className={ui.card}>
            <h3>{i.name}</h3>
            <p className={ui.badge}>{i.revoked ? "Revoked" : `${i.poolIds.length} pool grants · ${i.accountIds.length} direct account grants`}</p>
            {!i.revoked && (
              <div className={ui.actions}>
                <button type="button" onClick={() => setEditing(current => ({ integration: i, opened: (current?.opened ?? 0) + 1 }))}>Manage access</button>
                <ActionButton danger action={async () => {
                  if (!await confirm(`Revoke ${i.name}? Its session credentials will stop working. Pools and accounts remain available to other clients.`)) return;
                  await api("integrations/revoke", { id: i.id });
                  await router.reload();
                }}>Revoke integration</ActionButton>
              </div>
            )}
          </article>
        ))}
        {!integrations.length && <p className={ui.hint}>No connections. Pair from Yep Anywhere to get started.</p>}
      </div>
      {editing && overview && <GrantEditor key={editing.opened} integration={editing.integration} overview={overview} onClose={() => setEditing(undefined)} />}
    </>
  );
}
