import { useEffect, useRef, useState } from "react";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import type { Account } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";

/** Edits one account's nickname; router updates never touch what is typed. */
export function NicknameEditor({ account, onClose }: { account: Account; onClose(): void }) {
  const { api, router } = useApp();
  const [nickname, setNickname] = useState(account.nickname ?? "");
  const [pending, run] = useAction();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <form id="nickname-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        await api("accounts/set-nickname", { id: account.id, revision: account.revision, nickname });
        onClose();
        await router.reload();
      });
    }}>
      <p className={ui.profilePath}>{account.home ?? account.id}</p>
      <label>Nickname (optional)<input ref={input} name="nickname" maxLength={80} autoComplete="off" value={nickname} onChange={(event) => setNickname(event.target.value)} /></label>
      <p className={ui.hint}>Leave blank to remove the nickname. The profile folder stays the same.</p>
      <div className={ui.actions}>
        <button type="submit" disabled={pending}>Save nickname</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
