import "./styles/global.css";
import { createDashboard } from "./dashboard.ts";
import { errorText as text } from "./lib/format.ts";
import { AppClient, tauriPort, webSocketPort, type DesktopShell, type Port, type WebPort, type WebShell } from "./protocol/client.ts";
import type { Account, Integration, LoginStatus, Overview, Pool, RemovalPreview, RequestCompression } from "./protocol/types.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Control = HTMLInputElement & HTMLSelectElement;
/** A named control of a form. */
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as Control;
// One UI for both shells: the desktop relays the core's private socket, the
// browser uses the web dashboard's WebSocket. Only `shell` features differ.
const desktop = !!window.__TAURI__;
const port: Port = desktop ? await tauriPort() : webSocketPort();
const client = new AppClient(port);
const shell = client.shell;
const native = shell.native ? shell as DesktopShell : undefined;
document.body.dataset.shell = desktop ? "desktop" : "web";
const api = <T = Record<string, unknown>>(operation: string, body: object = {}) => client.call<T>(operation, body);
let stoppedByOwner = false;
let snapshot: Overview | undefined,
  update: { version?: string } | undefined,
  updateJob: Promise<void> | undefined,
  observationGeneration = 0;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
// An expired access token is not a lost login; only a failed renewal or a
// missing refresh token needs the user to sign in again.
const signInLabels: Record<string, string> = {
  ready: "Signed in",
  idle: "Signed in · access token renews on next use",
  renewing: "Renewing through the official CLI",
  renewal_failed: "Renewal failed — refresh usage to retry, or sign in again",
  login_required: "Sign in again",
  signed_out: "Not signed in",
  unusable: "Stored credentials unreadable",
};
/** The banner shows only when something is wrong; `startable` offers Start router in the desktop app. */
function setStatus(message: string, startable = false) {
  $("status-text").textContent = message;
  $("status").hidden = !message;
  $("start-router").hidden = !(message && startable && desktop);
}
function error(value: unknown) {
  $("error").textContent = value ? text(value) : "";
  $("error").hidden = !value;
}
async function run<T>(action: () => Promise<T>, button?: HTMLButtonElement) {
  error("");
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (e) {
    error(e);
  } finally {
    if (button) button.disabled = false;
  }
}
// WKWebView does not provide browser confirmation dialogs. Keep confirmation
// in our document so cancellation and keyboard behavior are the same everywhere.
function askConfirmation(message: string, action = "Continue") {
  const dialog = $<HTMLDialogElement>("confirmation-dialog");
  if (dialog.open) return Promise.resolve(false);
  $("confirmation-message").textContent = message;
  $("confirmation-accept").textContent = action;
  dialog.returnValue = "cancel";
  return new Promise<boolean>(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "accept"), { once: true });
    dialog.showModal();
  });
}
function button(text: string, action: () => Promise<unknown> | unknown, danger = false) {
  const el = element("button", text, danger ? "danger" : "");
  el.type = "button";
  el.onclick = () => run(async () => action(), el);
  return el;
}
function check(container: HTMLElement, value: string, label: string, selected: boolean) {
  const row = element("label", undefined, "check"),
    input = element("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = selected;
  row.append(input, document.createTextNode(label));
  container.append(row);
}
const checked = (id: string) => [...$(id).querySelectorAll<HTMLInputElement>("input:checked")].map((el) => el.value);
const accountLabel = (a: Pick<Account, "id"> & Partial<Account>) => `${a.home ?? a.id}${a.nickname ? ` · ${a.nickname}` : ""}`;
function members(selected: string[] = []) {
  $("members").replaceChildren();
  for (const a of snapshot!.accounts.filter(
    (a) => a.provider === field($<HTMLFormElement>("pool-form"), "provider").value,
  ))
    check($("members"), a.id, `${accountLabel(a)}${a.enabled ? "" : " · disabled"}`, selected.includes(a.id));
}
function editPool(pool?: Pool) {
  const form = $<HTMLFormElement>("pool-form");
  form.hidden = false;
  form.reset();
  const value = pool ?? {
    id: crypto.randomUUID(),
    revision: 0,
    name: "",
    provider: "codex",
    policy: "manual",
    accountIds: [],
  };
  for (const key of ["id", "revision", "name", "provider", "policy"] as const)
    field(form, key).value = String(value[key]);
  field(form, "provider").disabled = value.revision > 0;
  members(value.accountIds);
  $("pool-access").replaceChildren();
  for (const i of snapshot!.integrations.filter(i => !i.revoked))
    check($("pool-access"), i.id, i.name, i.poolIds.includes(value.id));
  if (!$("pool-access").childElementCount)
    $("pool-access").append(element("p", "No connections. Pair from Yep Anywhere to share this pool.", "hint"));
  $("pool-impact").textContent = pool && value.revision
    ? `${pool.bindings.reduce((n, b) => n + b.count, 0)} session pins reference this pool. Removing a member or deleting the pool blocks subsequent requests for affected pins.`
    : "Sessions use the default policy unless the app starting them picks another policy or a specific account. Automatic policies refresh stale quota and model observations when a session starts. Most remaining prefers the greatest headroom in the tightest applicable window. Weekly pace starts unused weekly timers first, backs off accounts under 30% short-window headroom, then prefers the account furthest behind its weekly pace.";
  $("delete-pool").hidden = !value.revision;
  field(form, "name").focus();
}
function editGrants(integration: Integration) {
  const form = $<HTMLFormElement>("grant-form");
  form.hidden = false;
  field(form, "id").value = integration.id;
  field(form, "revision").value = String(integration.revision);
  $("grant-title").textContent = `Access for ${integration.name}`;
  $("grant-pools").replaceChildren();
  $("grant-accounts").replaceChildren();
  for (const pool of snapshot!.pools)
    check(
      $("grant-pools"),
      pool.id,
      `${pool.name} · ${pool.provider}`,
      integration.poolIds.includes(pool.id),
    );
  for (const a of snapshot!.accounts)
    check($("grant-accounts"), a.id, accountLabel(a), integration.accountIds.includes(a.id));
}
let removal: RemovalPreview | undefined, removing = false;
async function openRemoval(account: Account) {
  removal = await api<RemovalPreview>("accounts/removal-preview", { id: account.id });
  $<HTMLFormElement>("remove-form").reset();
  $("remove-profile").textContent = removal.home;
  $("remove-impact").textContent = `Remove this account from the list and all pools. Existing sessions using it will lose access. You can enroll the folder again later as a new account.`;
  $<HTMLInputElement>("delete-profile").disabled = !removal.canDeleteProfile;
  $("delete-profile-detail").textContent = removal.reason;
  $("remove-error").hidden = true;
  $("confirm-remove").textContent = "Remove account";
  $<HTMLDialogElement>("remove-dialog").showModal();
}
$("delete-profile").onchange = () => {
  $("confirm-remove").textContent = $<HTMLInputElement>("delete-profile").checked ? "Remove & delete folder" : "Remove account";
};
$("cancel-remove").onclick = () => $<HTMLDialogElement>("remove-dialog").close();
$("remove-dialog").addEventListener("cancel", event => { if (removing) event.preventDefault(); });
$("remove-form").onsubmit = async event => {
  event.preventDefault();
  if (removing || !removal) return;
  removing = true;
  $<HTMLButtonElement>("confirm-remove").disabled = $<HTMLButtonElement>("cancel-remove").disabled = true;
  const deleteProfile = $<HTMLInputElement>("delete-profile").checked;
  $<HTMLInputElement>("delete-profile").disabled = true;
  $("remove-error").hidden = true;
  try {
    await api("accounts/remove", { id: removal.id, revision: removal.revision, deleteProfile,
      ...(deleteProfile ? { home: removal.home, deleteIdentity: removal.deleteIdentity } : {}) });
    $<HTMLDialogElement>("remove-dialog").close();
    // Do not leave an editor targeting an enrollment which no longer exists.
    if (field($<HTMLFormElement>("nickname-form"), "id").value === removal.id) $("nickname-form").hidden = true;
    await reload();
  } catch (failure) {
    $("remove-error").textContent = text(failure);
    $("remove-error").hidden = false;
  } finally {
    removing = false;
    $<HTMLButtonElement>("confirm-remove").disabled = $<HTMLButtonElement>("cancel-remove").disabled = false;
    $<HTMLInputElement>("delete-profile").disabled = !removal.canDeleteProfile;
  }
};
/** `start` (Start router and first load) may start a stopped desktop core; change events never do. */
async function reload(start = false) {
  const generation = ++observationGeneration;
  let next: Overview;
  try {
    if (!client.connected) {
      if (!start) throw new Error("Router unavailable");
      stoppedByOwner = false;
      await client.start(desktop);
    }
    next = await api<Overview>("overview");
  }
  catch (failure) { if (generation === observationGeneration) setStatus("Router unavailable", true); throw failure; }
  if (generation !== observationGeneration) return;
  snapshot = next;
  dashboard.refresh();
  // Unbundled routers (run from source) have no version to show.
  $("version").textContent = next.build?.source === "unbundled" ? "" : next.build?.version ?? "";
  setStatus("");
  $("accounts").replaceChildren();
  $("pools").replaceChildren();
  $("integrations").replaceChildren();
  // Editors are deliberately untouched by observation updates, including focus and typed text.
  for (const a of next.accounts) {
    const card = element("article", undefined, "card");
    card.append(
      element("h3", a.home ?? a.id, "profile-path"),
      ...(a.nickname ? [element("p", a.nickname, "nickname")] : []),
      element(
        "span",
        `${a.provider} · ${a.retired ? "retired" : a.enabled ? "enabled" : "disabled"} · usage ${a.freshness}`,
        "badge",
      ),
    );
    for (const w of a.windows) {
      const row = element("div", undefined, "quota");
      row.append(
        element(
          "span",
          `${w.bucket} · ${w.remainingPercent == null ? "Remaining unknown" : `${w.remainingPercent}% left`}`,
        ),
      );
      const bar = element("progress");
      bar.max = 100;
      if (w.remainingPercent != null) bar.value = w.remainingPercent;
      bar.setAttribute("aria-label", `${w.bucket} remaining`);
      row.append(bar);
      row.append(
        element(
          "small",
          `${w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : "Reset time unknown"} · scope: ${w.scope}`,
        ),
      );
      card.append(row);
    }
    if (!a.windows.length)
      card.append(
        element("p", "Quota not checked", "hint"),
      );
    if (a.error || a.blocked) card.append(element("p", (a.blocked ?? a.error)!, "unknown"));
    const login = next.logins.find((l) => l.id === a.id);
    if (login) card.append(element("p", `Sign-in: ${login.status}`, "hint"));
    const actions = element("div", undefined, "actions");
    actions.append(
      button("Sign in", async () => {
        if (native) {
          await native.terminalLogin(a.id, $<HTMLSelectElement>("terminal-presentation").value);
          await reload();
          return;
        }
        // A browser cannot open a terminal on the router's machine: show the official command.
        const { command } = await api<{ command: string }>("accounts/login-command", { id: a.id });
        card.querySelector(".login-command")?.remove();
        const box = element("div", undefined, "login-command");
        const code = element("pre", command);
        const copy = button("Copy command", () => navigator.clipboard.writeText(command));
        box.append(element("p", "Run this in a terminal on the router's machine, then choose Check sign-in:", "hint"), code, copy);
        card.insertBefore(box, actions);
      }),
      button("Check sign-in", async () => {
        const s = await api<LoginStatus>("accounts/login-status", { id: a.id });
        card.append(
          element("p", `${signInLabels[s.signIn] ?? `Sign-in: ${s.signIn}`} · sign-in ${s.loginStatus}`, "hint"),
        );
        if (s.canOpenLogin)
          card.append(button("Open sign-in page", () => api("accounts/open-login", { id: a.id })));
      }),
      button("Edit nickname", () => editNickname(a)),
      button("Refresh usage", async () => {
        await api("accounts/refresh", { id: a.id });
        await reload();
      }),
      button(
        a.enabled ? "Disable" : "Enable",
        async () => {
          if (
            a.enabled &&
            !(await askConfirmation(
              `Disable ${a.id}? ${a.bindingCount ?? 0} session pins reference this account. New requests on its session pins will be blocked. Accepted streams may finish. Credentials will be kept.`,
            ))
          )
            return;
          await api("accounts/set-enabled", {
            id: a.id,
            revision: a.revision,
            enabled: !a.enabled,
          });
          await reload();
        },
        a.enabled,
      ),
    );
    if (a.retired) actions.replaceChildren(element("span", "Retired · credential profile retained", "hint"));
    actions.append(button("Remove", () => openRemoval(a), true));
    if (login?.status === "running")
      actions.append(
        button("Cancel sign-in", async () => {
          await api("accounts/cancel-login", { id: a.id });
          await reload();
        }),
      );
    if (!a.retired) {
      const more = element("details", undefined, "account-more");
      more.append(element("summary", "More"));
      const secondary = element("div", undefined, "actions");
      for (const action of [...actions.children]) {
        if (!["Sign in", "Refresh usage", "Cancel sign-in"].includes(action.textContent ?? "")) secondary.append(action);
      }
      more.append(secondary);
      actions.append(more);
    }
    card.append(actions);
    $("accounts").append(card);
  }
  if (!next.accounts.length)
    $("accounts").append(element("p", "Add your first account below.", "hint"));
  for (const p of next.pools) {
    const card = element("article", undefined, "card");
    card.append(
      element("h3", p.name),
      element(
        "p",
        `${p.provider} · ${p.policy === "manual" ? "Manual" : p.policy === "most-remaining" ? "Most remaining" : p.policy === "weekly-pace" ? "Weekly pace" : p.policy === "round-robin" ? "Round robin" : "Unsupported policy"} · ${p.accountIds.length} accounts`,
        "badge",
      ),
      element("p", p.accountIds.map(id => accountLabel(next.accounts.find(a => a.id === id) ?? { id })).join(", "), "hint profile-path"),
      button("Edit pool", () => editPool(p)),
    );
    $("pools").append(card);
  }
  if (!next.pools.length)
    $("pools").append(
      element("p", "No pools", "hint"),
    );
  for (const i of next.integrations) {
    const card = element("article", undefined, "card");
    card.append(
      element("h3", i.name),
      element(
        "p",
        i.revoked
          ? "Revoked"
          : `${i.poolIds.length} pool grants · ${i.accountIds.length} direct account grants`,
        "badge",
      ),
    );
    if (!i.revoked) {
      const actions = element("div", undefined, "actions");
      actions.append(
        button("Manage access", () => editGrants(i)),
        button(
          "Revoke integration",
          async () => {
            if (
              !(await askConfirmation(
                `Revoke ${i.name}? Its session credentials will stop working. Pools and accounts remain available to other clients.`,
              ))
            )
              return;
            await api("integrations/revoke", { id: i.id });
            await reload();
          },
          true,
        ),
      );
      card.append(actions);
    }
    $("integrations").append(card);
  }
  if (!next.integrations.length)
    $("integrations").append(element("p", "No connections. Pair from Yep Anywhere to get started.", "hint"));
}
function editNickname(a: Account) {
  const form = $<HTMLFormElement>("nickname-form");
  form.hidden = false;
  field(form, "id").value = a.id;
  field(form, "revision").value = String(a.revision);
  field(form, "nickname").value = a.nickname ?? "";
  $("nickname-profile").textContent = a.home ?? a.id;
  field(form, "nickname").focus();
}
$("nickname-form").onsubmit = e => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void run(async () => {
    await api("accounts/set-nickname", { id: field(form, "id").value, revision: Number(field(form, "revision").value), nickname: field(form, "nickname").value });
    form.hidden = true;
    await reload();
  }, form.querySelector("button")!);
};
$("cancel-nickname").onclick = () => { $("nickname-form").hidden = true; };
$("providers").onclick = () =>
  run(async () => {
    const result = await api<{ providers: { provider: string; available: boolean; version?: string }[] }>("providers");
    $("provider-status").textContent = result.providers
      .map(
        (p) =>
          `${p.provider}: ${p.available ? (p.version ?? "available") : "not found — install the official CLI"}`,
      )
      .join(" · ");
  }, $<HTMLButtonElement>("providers"));
$("start-router").onclick = () => run(() => reload(true), $<HTMLButtonElement>("start-router"));
$("new-pool").onclick = () => {
  if (snapshot) editPool();
};
$("cancel-pool").onclick = () => {
  $("pool-form").hidden = true;
};
$("cancel-grants").onclick = () => {
  $("grant-form").hidden = true;
};
field($<HTMLFormElement>("pool-form"), "provider").onchange = () => members();
const accountForm = $<HTMLFormElement>("account-form");
let profileGeneration = 0, addingAccount = false;
const profileInput = () => ({ provider: field(accountForm, "provider").value, home: field(accountForm, "home").value, credentialStore: field(accountForm, "credentialStore").value });
function accountSetupChanged() {
  profileGeneration++;
  const existing = field(accountForm, "enrollment").value === "existing";
  $("existing-profile").hidden = !existing;
  field(accountForm, "home").required = existing;
  field(accountForm, "home").placeholder = existing ? "/path/to/existing/profile" : "Leave blank to create a dedicated profile";
  $("profile-preview").textContent = "";
  $("account-error").hidden = true;
}
for (const name of ["enrollment", "provider", "home", "credentialStore"]) field(accountForm, name).addEventListener("input", accountSetupChanged);
$("discover-profiles").onclick = () => run(async () => {
  const generation = profileGeneration;
  const result = await api<{ profiles: { home: string; enrolled: boolean }[] }>("profiles/discover", { provider: field(accountForm, "provider").value });
  if (generation !== profileGeneration) return;
  $("profile-candidates").replaceChildren();
  for (const p of result.profiles) {
    const choice = button(`${p.home}${p.enrolled ? " · already enrolled" : ""}`, () => {
      field(accountForm, "home").value = p.home;
      accountSetupChanged();
    });
    choice.disabled = p.enrolled;
    $("profile-candidates").append(choice);
  }
  if (!result.profiles.length) $("profile-candidates").textContent = "No profiles found. Enter a folder to check it.";
}, $<HTMLButtonElement>("discover-profiles"));
$("inspect-profile").onclick = () => run(async () => {
  const input = profileInput(), generation = profileGeneration;
  const result = await api<{ credentialStore: string; credentialStatus: string; detail: string }>("profiles/inspect", input);
  if (generation !== profileGeneration) return;
  $("profile-preview").textContent = `${result.credentialStore} · ${result.credentialStatus} · ${result.detail}`;
}, $<HTMLButtonElement>("inspect-profile"));
accountForm.onsubmit = async (e) => {
  e.preventDefault();
  if (addingAccount) return;
  addingAccount = true;
  const body: Record<string, FormDataEntryValue> = Object.fromEntries(new FormData(accountForm));
  const submit = accountForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const controls = [...accountForm.elements].map(control => [control, (control as Control).disabled] as const);
  for (const [control] of controls) (control as Control).disabled = true;
  submit.textContent = body.enrollment === "existing" ? "Checking & adding…" : "Adding…";
  $("account-error").hidden = true;
  try {
    if (body.enrollment !== "existing") {
      delete body.enrollment;
      delete body.credentialStore;
    }
    if (!body.home) delete body.home;
    // The owner API validates existing profiles on every enrollment. A separate
    // preview is optional and must never be an unexplained submission gate.
    await api("accounts/add", body);
    accountForm.reset();
    accountSetupChanged();
    $("profile-candidates").replaceChildren();
    await reload();
  } catch (failure) {
    $("account-error").textContent = String(failure);
    $("account-error").hidden = false;
  } finally {
    addingAccount = false;
    for (const [control, disabled] of controls) (control as Control).disabled = disabled;
    submit.textContent = "Add account";
  }
};
$("pool-form").onsubmit = (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void run(async () => {
    const id = field(form, "id").value;
    await api("pools/save", {
      id,
      revision: Number(field(form, "revision").value),
      name: field(form, "name").value,
      provider: field(form, "provider").value,
      policy: field(form, "policy").value,
      accountIds: checked("members"),
    });
    // Sharing writes each changed connection's grant, as Manage access does.
    const shared = checked("pool-access");
    for (const i of snapshot!.integrations.filter(i => !i.revoked && i.poolIds.includes(id) !== shared.includes(i.id)))
      await api("grants/save", {
        id: i.id,
        revision: i.revision,
        poolIds: shared.includes(i.id) ? [...i.poolIds, id] : i.poolIds.filter(p => p !== id),
        accountIds: i.accountIds,
      });
    form.hidden = true;
    await reload();
  }, form.querySelector<HTMLButtonElement>("button[type=submit]")!);
};
$("delete-pool").onclick = () =>
  run(async () => {
    const form = $<HTMLFormElement>("pool-form");
    if (
      !(await askConfirmation(
        `Delete ${field(form, "name").value}? Its session pins will stop working. Accounts remain enrolled.`,
      ))
    )
      return;
    await api("pools/remove", {
      id: field(form, "id").value,
      revision: Number(field(form, "revision").value),
    });
    form.hidden = true;
    await reload();
  }, $<HTMLButtonElement>("delete-pool"));
$("grant-form").onsubmit = (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void run(async () => {
    await api("grants/save", {
      id: field(form, "id").value,
      revision: Number(field(form, "revision").value),
      poolIds: checked("grant-pools"),
      accountIds: checked("grant-accounts"),
    });
    form.hidden = true;
    await reload();
  }, form.querySelector<HTMLButtonElement>("button[type=submit]")!);
};
$("startup").onchange = () =>
  run(async () => {
    const el = $<HTMLInputElement>("startup"),
      desired = el.checked;
    try {
      el.checked = await native!.startup(desired);
    } catch (e) {
      el.checked = !desired;
      throw e;
    }
  });
async function checkUpdate() {
  return (updateJob ??= (async () => {
    const result = await native!.checkUpdate();
    if (result.version) {
      update = result;
      $("update-status").textContent =
        `Version ${result.version} is available. Install when your requests and sign-ins have finished.`;
      $("install-update").hidden = false;
    } else {
      update = undefined;
      $("install-update").hidden = true;
      $("update-status").textContent = "You have the latest published version.";
    }
  })().finally(() => {
    updateJob = undefined;
  }));
}
$("check-update").onclick = () => run(checkUpdate, $<HTMLButtonElement>("check-update"));
if (native) {
  setTimeout(() => {
    void checkUpdate().catch(() => {
      $("update-status").textContent = "Update check unavailable. You can try again manually.";
    });
  }, 5000);
  setInterval(
    () => {
      void checkUpdate().catch(() => {});
    },
    24 * 60 * 60 * 1000,
  );
}

$("install-update").onclick = () =>
  run(async () => {
    if (!update?.version) return;
    const version = update.version;
    if (!await askConfirmation(`Install ${version} and relaunch? The router must be idle.`, "Install & relaunch")) return;
    $("update-status").textContent = `Downloading and installing ${version}… The app will relaunch when finished.`;
    try {
      await native!.installUpdate(version);
    } catch (e) {
      $("update-status").textContent = `Update failed: ${String(e)}`;
      throw e;
    }
  }, $<HTMLButtonElement>("install-update"));
$("stop").onclick = () =>
  run(async () => {
    if (
      !snapshot ||
      !(await askConfirmation(
        "Stop the router? Idle sessions will be unable to send requests until it is started again. Active requests or sign-ins prevent stopping.",
      ))
    )
      return;
    stoppedByOwner = true;
    try { await api("stop", { routerId: snapshot.routerId }); }
    catch (failure) { stoppedByOwner = false; throw failure; }
    setStatus(desktop ? "Router stopped." : "Router stopped. Start it again with aar serve.", true);
  }, $<HTMLButtonElement>("stop"));
if (native) void native.startup(null)
  .then((enabled) => {
    $<HTMLInputElement>("startup").checked = enabled;
  })
  .catch(error);

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function selectTab(tab: HTMLButtonElement) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute("aria-controls")!).hidden = !selected;
  }
  dashboard.show(tab.id === "tab-dashboard");
  if (tab.id === "tab-settings") { void loadRetention(); void loadCompression(); }
}

// History retention is stored by the router, so the CLI, web and desktop share it.
async function loadRetention() {
  try {
    const { stored, retentionDays } = await api<{ stored: boolean; retentionDays: number | null }>("history/settings");
    const select = $<HTMLSelectElement>("retention"), value = retentionDays === null ? "forever" : String(retentionDays);
    // A retention set elsewhere (CLI or an older version) stays selectable.
    select.querySelector("option[data-custom]")?.remove();
    if (![...select.options].some(o => o.value === value)) {
      const custom = element("option", `${retentionDays} days`);
      custom.value = value;
      custom.dataset.custom = "";
      select.prepend(custom);
    }
    select.value = value;
    select.disabled = !stored;
    $("retention-status").textContent = stored ? "" : "History is not stored: the router could not open its database.";
  } catch (failure) { $("retention-status").textContent = text(failure); }
}
// Request compression per provider; off sends bodies upstream as received.
async function loadCompression() {
  try {
    const { requestCompression } = await api<{ requestCompression: RequestCompression }>("settings/request-compression");
    for (const provider of ["claude", "codex"] as const) $<HTMLSelectElement>(`compress-${provider}`).value = requestCompression[provider];
    $("compression-status").textContent = "";
  } catch (failure) { $("compression-status").textContent = text(failure); }
}
for (const provider of ["claude", "codex"]) {
  $(`compress-${provider}`).onchange = async () => {
    try {
      await api("settings/request-compression", { provider, value: $<HTMLSelectElement>(`compress-${provider}`).value });
      $("compression-status").textContent = "";
    } catch (failure) { $("compression-status").textContent = text(failure); void loadCompression(); }
  };
}
$("retention").onchange = async () => {
  const value = $<HTMLSelectElement>("retention").value;
  try {
    await api("history/set-retention", { retentionDays: value === "forever" ? null : Number(value) });
    $("retention-status").textContent = "";
  } catch (failure) { $("retention-status").textContent = text(failure); void loadRetention(); }
};
for (const tab of tabs) {
  tab.onclick = () => selectTab(tab);
  tab.onkeydown = event => {
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      selectTab(tabs[next]!);
      tabs[next]!.focus();
    }
  };
}

$<HTMLSelectElement>("terminal-presentation").value = localStorage.getItem("terminal-presentation") === "embedded" ? "embedded" : "external";
$("terminal-presentation").onchange = () => localStorage.setItem("terminal-presentation", $<HTMLSelectElement>("terminal-presentation").value);

// The desktop WebView would navigate itself; the shell opens the browser instead.
if (native) $("project-link").onclick = (event) => { event.preventDefault(); native.openProject().catch(error); };
if (native) void native.onLifecycleError((payload) => { error(payload); setStatus("Router could not stop"); });

// Registry changes (pairing, CLI edits, sign-in progress) arrive as change
// events. Coalesce bursts; observation preserves editors and never starts a stopped core.
let observationDirty = false, observationJob: Promise<void> | undefined;
function stateChanged() {
  observationDirty = true;
  if (observationJob) return;
  observationJob = (async () => {
    while (observationDirty) {
      observationDirty = false;
      try { await reload(); } catch { /* The status conveys unavailability. */ }
    }
  })().finally(() => { observationJob = undefined; });
}
const dashboard = createDashboard({ client, overview: () => snapshot });
client.onChange(stateChanged);
client.onStatus((state) => {
  if (state === "connected") { stateChanged(); return; }
  if (stoppedByOwner) { client.pause(); return; }
  setStatus(desktop ? "Router unavailable · reconnecting" : "Router unavailable · reconnecting. Restart it with aar serve if it stopped.", true);
});
selectTab(tabs.find(t => t.getAttribute("aria-selected") === "true") ?? tabs[0]!);

if (!desktop) {
  const web = shell as WebShell;
  $("logout").onclick = () => run(async () => {
    await web.logout();
    location.reload();
  }, $<HTMLButtonElement>("logout"));
  const session = await (port as WebPort).authenticate();
  if (!session.authenticated) {
    $("app-shell").hidden = true;
    $("signed-out").hidden = false;
    $("signed-out-detail").textContent = session.error ?? "This browser is not signed in.";
    setStatus("");
  }
  if (session.authenticated) void run(() => reload(true));
} else void run(() => reload(true));
