import { useEffect, useRef, useState } from "react";
import { useApp } from "../app/context.tsx";
import dialogStyles from "../app/dialog.module.css";
import { errorText } from "../lib/format.ts";
import type { RemovalPreview } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";

/**
 * Confirms removing an account. Deleting the profile folder is a separate,
 * unchecked choice every time the dialog opens; Cancel has focus.
 */
export function RemoveAccountDialog({ preview, onClose, onRemoved }: {
  preview: RemovalPreview | undefined;
  onClose(): void;
  onRemoved(id: string): void;
}) {
  const { api, router } = useApp();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const [deleteProfile, setDeleteProfile] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (!element || !preview) return;
    setDeleteProfile(false);
    setFailure("");
    if (!element.open) element.showModal();
    cancel.current?.focus();
  }, [preview]);
  const remove = async () => {
    if (removing || !preview) return;
    setRemoving(true);
    setFailure("");
    try {
      await api("accounts/remove", { id: preview.id, revision: preview.revision, deleteProfile,
        ...(deleteProfile ? { home: preview.home, deleteIdentity: preview.deleteIdentity } : {}) });
      dialog.current?.close();
      onRemoved(preview.id);
      await router.reload();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <dialog ref={dialog} id="remove-dialog" aria-labelledby="remove-title" onClose={onClose}
      onCancel={(event) => { if (removing) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void remove(); }}>
        <h2 id="remove-title">Remove account?</h2>
        <p className={ui.profilePath}>{preview?.home}</p>
        <p className={ui.hint}>Remove this account from the list and all pools. Existing sessions using it will lose access. You can enroll the folder again later as a new account.</p>
        <p className={ui.hint}>The profile folder and credentials are kept unless you select the option below.</p>
        <label className={ui.check}>
          <input type="checkbox" checked={deleteProfile} disabled={removing || !preview?.canDeleteProfile} onChange={(event) => setDeleteProfile(event.target.checked)} />
          Also delete the profile folder
        </label>
        <p className={ui.hint}>{preview?.reason}</p>
        <p className={ui.danger} role="alert" hidden={!failure}>{failure}</p>
        <div className={`${ui.actions} ${dialogStyles.actions}`}>
          <button ref={cancel} type="button" disabled={removing} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className={`${ui.danger} ${dialogStyles.danger}`} disabled={removing}>{deleteProfile ? "Remove & delete folder" : "Remove account"}</button>
        </div>
      </form>
    </dialog>
  );
}
