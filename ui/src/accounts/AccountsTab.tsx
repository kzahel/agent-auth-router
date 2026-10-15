import { useState } from "react";
import { useApp, useRouterView } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import type { Account, RemovalPreview } from "../protocol/types.ts";
import type { TerminalPresentation } from "../settings/SettingsTab.tsx";
import ui from "../styles/ui.module.css";
import { AccountCard } from "./AccountCard.tsx";
import styles from "./accounts.module.css";
import { AddAccountForm } from "./AddAccountForm.tsx";
import { NicknameEditor } from "./NicknameEditor.tsx";
import { RemoveAccountDialog } from "./RemoveAccountDialog.tsx";

export function AccountsTab({ presentation }: { presentation: TerminalPresentation }) {
  const { api } = useApp();
  const { overview } = useRouterView();
  // Each Edit nickname opens a fresh editor, even for the same account.
  const [nickname, setNickname] = useState<{ account: Account; opened: number }>();
  const [removal, setRemoval] = useState<RemovalPreview>();
  const [providers, setProviders] = useState("");
  const [checking, check] = useAction();
  const accounts = overview?.accounts ?? [];
  return (
    <>
      <details className={styles.help}>
        <summary>Account setup</summary>
        <p className={`${ui.hint} ${styles.helpText}`}>Install Claude Code or Codex first. Sign in opens your chosen terminal with the selected profile. Choose Terminal.app or the built-in terminal in App settings. Choose a login method there and follow the official CLI prompts. Enrolling an account does not grant an integration access.</p>
        <button id="providers" type="button" disabled={checking} onClick={() => void check(async () => {
          const result = await api<{ providers: { provider: string; available: boolean; version?: string }[] }>("providers");
          setProviders(result.providers.map(p => `${p.provider}: ${p.available ? (p.version ?? "available") : "not found — install the official CLI"}`).join(" · "));
        })}>Check installed CLIs</button>
        <p className={`${ui.hint} ${styles.providerStatus}`} role="status">{providers}</p>
      </details>
      <div id="accounts" className={ui.cards}>
        {accounts.map(a => (
          <AccountCard key={a.id} account={a} login={overview?.logins.find(l => l.id === a.id)} presentation={presentation}
            onEditNickname={() => setNickname(current => ({ account: a, opened: (current?.opened ?? 0) + 1 }))}
            onRemove={async () => setRemoval(await api<RemovalPreview>("accounts/removal-preview", { id: a.id }))} />
        ))}
        {!accounts.length && <p className={ui.hint}>Add your first account below.</p>}
      </div>
      {nickname && <NicknameEditor key={nickname.opened} account={nickname.account} onClose={() => setNickname(undefined)} />}
      <AddAccountForm />
      <RemoveAccountDialog preview={removal} onClose={() => setRemoval(undefined)}
        // Do not leave an editor targeting an enrollment which no longer exists.
        onRemoved={(id) => setNickname(current => current?.account.id === id ? undefined : current)} />
    </>
  );
}
