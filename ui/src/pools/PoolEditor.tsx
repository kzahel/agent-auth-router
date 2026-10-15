import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../app/ConfirmDialog.tsx";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import { CheckList } from "../components/CheckList.tsx";
import { accountLabel } from "../lib/accounts.ts";
import type { Overview, Pool, Provider } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";

const NEW_POOL_HINT = "Sessions use the default policy unless the app starting them picks another policy or a specific account. Automatic policies refresh stale quota and model observations when a session starts. Most remaining prefers the greatest headroom in the tightest applicable window. Weekly pace starts unused weekly timers first, backs off accounts under 30% short-window headroom, then prefers the account furthest behind its weekly pace.";

/**
 * Creates or edits a pool: members, default policy and which connections may
 * use it. What is typed survives router updates; the lists follow them.
 */
export function PoolEditor({ pool, overview, onClose }: { pool: Pool | undefined; overview: Overview; onClose(): void }) {
  const { api, router } = useApp();
  const confirm = useConfirm();
  const [id] = useState(() => pool?.id ?? crypto.randomUUID());
  const revision = pool?.revision ?? 0;
  const [name, setName] = useState(pool?.name ?? "");
  const [provider, setProvider] = useState<Provider>(pool?.provider ?? "codex");
  const [policy, setPolicy] = useState<string>(pool?.policy ?? "manual");
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set(pool?.accountIds));
  const [access, setAccess] = useState<ReadonlySet<string>>(() => new Set(overview.integrations.filter(i => !i.revoked && i.poolIds.includes(id)).map(i => i.id)));
  const [saving, save] = useAction();
  const [deleting, remove] = useAction();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  const integrations = overview.integrations.filter(i => !i.revoked);

  return (
    <form id="pool-form" onSubmit={(event) => {
      event.preventDefault();
      void save(async () => {
        await api("pools/save", { id, revision, name, provider, policy, accountIds: [...members] });
        // Sharing writes each changed connection's grant, as Manage access does.
        for (const i of router.view.overview?.integrations.filter(i => !i.revoked && i.poolIds.includes(id) !== access.has(i.id)) ?? [])
          await api("grants/save", {
            id: i.id,
            revision: i.revision,
            poolIds: access.has(i.id) ? [...i.poolIds, id] : i.poolIds.filter(p => p !== id),
            accountIds: i.accountIds,
          });
        onClose();
        await router.reload();
      });
    }}>
      <label>Pool name<input ref={nameInput} name="name" required maxLength={80} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Provider
        <select name="provider" disabled={revision > 0} value={provider} onChange={(event) => { setProvider(event.target.value as Provider); setMembers(new Set()); }}>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      <label>Default policy
        <select name="policy" value={policy} onChange={(event) => setPolicy(event.target.value)}>
          <option value="manual">Manual</option>
          <option value="round-robin">Round robin</option>
          <option value="most-remaining">Most remaining</option>
          <option value="weekly-pace">Weekly pace</option>
        </select>
      </label>
      <fieldset>
        <legend>Members</legend>
        <CheckList id="members" selected={members} onChange={setMembers}
          items={overview.accounts.filter(a => a.provider === provider).map(a => ({ value: a.id, label: `${accountLabel(a)}${a.enabled ? "" : " · disabled"}` }))} />
      </fieldset>
      <fieldset>
        <legend>Available to</legend>
        <CheckList id="pool-access" selected={access} onChange={setAccess}
          items={integrations.map(i => ({ value: i.id, label: i.name }))}
          empty={<p className={ui.hint}>No connections. Pair from Yep Anywhere to share this pool.</p>} />
      </fieldset>
      <p id="pool-impact" className={ui.hint}>
        {pool && revision
          ? `${pool.bindings.reduce((n, b) => n + b.count, 0)} session pins reference this pool. Removing a member or deleting the pool blocks subsequent requests for affected pins.`
          : NEW_POOL_HINT}
      </p>
      <div className={ui.actions}>
        <button type="submit" disabled={saving}>Save pool</button>
        <button type="button" onClick={onClose}>Cancel</button>
        {revision > 0 && (
          <button type="button" className={ui.danger} disabled={deleting} onClick={() => void remove(async () => {
            if (!await confirm(`Delete ${name}? Its session pins will stop working. Accounts remain enrolled.`)) return;
            await api("pools/remove", { id, revision });
            onClose();
            await router.reload();
          })}>Delete pool</button>
        )}
      </div>
    </form>
  );
}
