// WKWebView does not provide browser confirmation dialogs. Keep confirmation
// in our document so cancellation and keyboard behavior are the same everywhere.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import ui from "../styles/ui.module.css";
import styles from "./dialog.module.css";

type Confirm = (message: string, action?: string) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async () => false);

/** Asks the user to confirm; resolves false on Cancel or Escape, or if a question is already open. */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const resolve = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const [question, setQuestion] = useState({ message: "", action: "Continue" });
  const confirm = useCallback<Confirm>((message, action = "Continue") => {
    const element = dialog.current;
    if (!element || element.open) return Promise.resolve(false);
    flushSync(() => setQuestion({ message, action }));
    element.returnValue = "cancel";
    return new Promise<boolean>(done => {
      resolve.current = done;
      element.showModal();
      cancel.current?.focus();
    });
  }, []);
  const closed = () => {
    resolve.current?.(dialog.current?.returnValue === "accept");
    resolve.current = undefined;
  };
  return (
    <ConfirmContext value={confirm}>
      {children}
      <dialog ref={dialog} id="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message" onClose={closed}>
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <h2 id="confirmation-title">Confirm action</h2>
          <p id="confirmation-message">{question.message}</p>
          <div className={`${ui.actions} ${styles.actions}`}>
            <button ref={cancel} type="button" value="cancel" onClick={() => dialog.current?.close("cancel")}>Cancel</button>
            <button id="confirmation-accept" type="button" value="accept" onClick={() => dialog.current?.close("accept")}>{question.action}</button>
          </div>
        </form>
      </dialog>
    </ConfirmContext>
  );
}
