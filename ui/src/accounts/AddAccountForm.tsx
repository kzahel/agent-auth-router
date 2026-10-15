import { useRef, useState } from "react";
import { useApp } from "../app/context.tsx";
import { useAction } from "../app/use-action.ts";
import type { Provider } from "../protocol/types.ts";
import ui from "../styles/ui.module.css";
import styles from "./accounts.module.css";

type Enrollment = "new" | "existing";
const EMPTY = { enrollment: "new" as Enrollment, provider: "codex" as Provider, home: "", credentialStore: "auto", nickname: "" };

/**
 * Enrolls an account: a dedicated new profile, or an existing profile folder.
 * Check profile is an optional preview; Add account never waits on it.
 */
export function AddAccountForm() {
  const { api, router } = useApp();
  const [fields, setFields] = useState(EMPTY);
  const [candidates, setCandidates] = useState<{ home: string; enrolled: boolean }[]>();
  const [preview, setPreview] = useState("");
  const [failure, setFailure] = useState("");
  const [adding, setAdding] = useState(false);
  const [discovering, discover] = useAction();
  const [inspecting, inspect] = useAction();
  // Answers for a setup the user has since changed are dropped.
  const generation = useRef(0);
  const existing = fields.enrollment === "existing";

  const setup = (change: Partial<typeof EMPTY>) => {
    generation.current++;
    setFields(current => ({ ...current, ...change }));
    setPreview("");
    setFailure("");
  };
  const submit = async () => {
    if (adding) return;
    setAdding(true);
    setFailure("");
    const body: Partial<typeof EMPTY> = { ...fields };
    if (body.enrollment !== "existing") {
      delete body.enrollment;
      delete body.credentialStore;
    }
    if (!body.home) delete body.home;
    try {
      // The owner API validates existing profiles on every enrollment. A separate
      // preview is optional and must never be an unexplained submission gate.
      await api("accounts/add", body);
      setup(EMPTY);
      setCandidates(undefined);
      await router.reload();
    } catch (error) {
      setFailure(String(error));
    } finally {
      setAdding(false);
    }
  };

  return (
    <details>
      <summary>Add account</summary>
      <form id="account-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label>Profile setup
          <select name="enrollment" disabled={adding} value={fields.enrollment} onChange={(event) => setup({ enrollment: event.target.value as Enrollment })}>
            <option value="new">Create dedicated profile</option>
            <option value="existing">Use existing profile</option>
          </select>
        </label>
        <label>Provider
          <select name="provider" disabled={adding} value={fields.provider} onChange={(event) => setup({ provider: event.target.value as Provider })}>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label>Profile folder
          <input name="home" disabled={adding} required={existing} autoComplete="off" value={fields.home}
            placeholder={existing ? "/path/to/existing/profile" : "Leave blank to create a dedicated profile"}
            onChange={(event) => setup({ home: event.target.value })} />
        </label>
        <div hidden={!existing}>
          <div className={ui.actions}>
            <button type="button" disabled={adding || discovering} onClick={() => void discover(async () => {
              const asked = generation.current;
              const result = await api<{ profiles: { home: string; enrolled: boolean }[] }>("profiles/discover", { provider: fields.provider });
              if (asked === generation.current) setCandidates(result.profiles);
            })}>Find profiles</button>
            <button type="button" disabled={adding || inspecting} onClick={() => void inspect(async () => {
              const asked = generation.current;
              const result = await api<{ credentialStore: string; credentialStatus: string; detail: string }>("profiles/inspect",
                { provider: fields.provider, home: fields.home, credentialStore: fields.credentialStore });
              if (asked === generation.current) setPreview(`${result.credentialStore} · ${result.credentialStatus} · ${result.detail}`);
            })}>Check profile</button>
          </div>
          <div className={styles.candidates}>
            {candidates?.map(p => (
              <button key={p.home} type="button" disabled={adding || p.enrolled} onClick={() => setup({ home: p.home })}>
                {`${p.home}${p.enrolled ? " · already enrolled" : ""}`}
              </button>
            ))}
            {candidates && !candidates.length && "No profiles found. Enter a folder to check it."}
          </div>
          <label>Credential storage
            <select name="credentialStore" disabled={adding} value={fields.credentialStore} onChange={(event) => setup({ credentialStore: event.target.value })}>
              <option value="auto">Choose from provider and folder</option>
              <option value="file">Credential file</option>
              <option value="claude-keychain-default">Mac Keychain · normal Claude CLI</option>
              <option value="claude-keychain">Mac Keychain · explicit CLAUDE_CONFIG_DIR</option>
            </select>
          </label>
          <p className={ui.hint}>Add account checks the profile automatically. Check profile is an optional preview. Enrollment leaves its files and permissions unchanged. Sign in only if needed; CLI sign-in and renewal can update its credentials.</p>
          <p id="profile-preview" className={ui.hint} role="status">{preview}</p>
        </div>
        <label>Nickname (optional)
          <input name="nickname" maxLength={80} placeholder="Work" autoComplete="off" disabled={adding} value={fields.nickname}
            onChange={(event) => setFields(current => ({ ...current, nickname: event.target.value }))} />
        </label>
        <p id="account-error" className={ui.danger} role="alert" hidden={!failure}>{failure}</p>
        <button type="submit" disabled={adding} aria-describedby="account-error">
          {adding ? existing ? "Checking & adding…" : "Adding…" : "Add account"}
        </button>
      </form>
    </details>
  );
}
