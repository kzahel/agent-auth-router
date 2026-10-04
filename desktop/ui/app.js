const $ = (id) => document.getElementById(id);
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const api = (operation, body = {}) => invoke("router", { operation, body });
let snapshot,
  update,
  updateJob,
  observationGeneration = 0;
const element = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
function error(value) {
  $("error").textContent = value ? String(value) : "";
  $("error").hidden = !value;
}
async function run(action, button) {
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
function button(text, action, danger = false) {
  const el = element("button", text, danger ? "danger" : "");
  el.type = "button";
  el.onclick = () => run(action, el);
  return el;
}
function check(container, value, label, selected) {
  const row = element("label", undefined, "check"),
    input = element("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = selected;
  row.append(input, document.createTextNode(label));
  container.append(row);
}
const checked = (id) => [...$(id).querySelectorAll("input:checked")].map((el) => el.value);
const accountLabel = a => `${a.home ?? a.id}${a.nickname ? ` · ${a.nickname}` : ""}`;
function members(selected = []) {
  $("members").replaceChildren();
  for (const a of snapshot.accounts.filter(
    (a) => a.provider === $("pool-form").elements.provider.value,
  ))
    check($("members"), a.id, `${accountLabel(a)}${a.enabled ? "" : " · disabled"}`, selected.includes(a.id));
}
function editPool(pool) {
  const form = $("pool-form");
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
  for (const key of ["id", "revision", "name", "provider", "policy"])
    form.elements[key].value = value[key];
  form.elements.provider.disabled = value.revision > 0;
  members(value.accountIds);
  $("pool-impact").textContent = value.revision
    ? `${pool.bindings.reduce((n, b) => n + b.count, 0)} session pins reference this pool. Removing a member or deleting the pool blocks subsequent requests for affected pins.`
    : "Automatic policies refresh stale quota and model observations when a session starts. Most remaining prefers the greatest headroom in the tightest applicable window.";
  $("delete-pool").hidden = !value.revision;
  form.elements.name.focus();
}
function editGrants(integration) {
  const form = $("grant-form");
  form.hidden = false;
  form.elements.id.value = integration.id;
  form.elements.revision.value = integration.revision;
  $("grant-title").textContent = `Access for ${integration.name}`;
  $("grant-pools").replaceChildren();
  $("grant-accounts").replaceChildren();
  for (const pool of snapshot.pools)
    check(
      $("grant-pools"),
      pool.id,
      `${pool.name} · ${pool.provider}`,
      integration.poolIds.includes(pool.id),
    );
  for (const a of snapshot.accounts)
    check($("grant-accounts"), a.id, accountLabel(a), integration.accountIds.includes(a.id));
}
async function reload() {
  const generation = ++observationGeneration;
  const next = await api("overview");
  if (generation !== observationGeneration) return;
  snapshot = next;
  $("version").textContent = next.build?.version ?? "development";
  $("status").textContent =
    `Router running · ${next.activeRequests} active request${next.activeRequests === 1 ? "" : "s"}`;
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
    if (a.error || a.blocked) card.append(element("p", a.blocked ?? a.error, "unknown"));
    const login = next.logins.find((l) => l.id === a.id);
    if (login) card.append(element("p", `Sign-in: ${login.status}`, "hint"));
    const actions = element("div", undefined, "actions");
    actions.append(
      button("Sign in", async () => {
        await api("accounts/terminal-login", { id: a.id, presentation: $("terminal-presentation").value });
        await reload();
      }),
      button("Check sign-in", async () => {
        const s = await api("accounts/login-status", { id: a.id });
        card.append(
          element("p", `${s.credentialStatus === "expired" ? "Session expired — sign in again" : s.credentialStatus === "ok" ? "Stored credentials readable" : `Credentials: ${s.credentialStatus}`} · sign-in ${s.loginStatus}`, "hint"),
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
            !confirm(
              `Disable ${a.id}? ${a.bindingCount ?? 0} session pins reference this account. New requests on its session pins will be blocked. Accepted streams may finish. Credentials will be kept.`,
            )
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
    if (!a.retired)
      actions.append(
        button(
          "Retire",
          async () => {
            if (
              !confirm(
                `Retire ${a.id}? ${a.bindingCount ?? 0} session pins reference it. Requests will be blocked, and this ID cannot be reused. The official credential profile will be kept.`,
              )
            )
              return;
            await api("accounts/retire", { id: a.id, revision: a.revision });
            await reload();
          },
          true,
        ),
      );
    else actions.replaceChildren(element("span", "Retired · credential profile retained", "hint"));
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
        if (!["Sign in", "Refresh usage", "Cancel sign-in"].includes(action.textContent)) secondary.append(action);
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
        `${p.provider} · ${p.policy === "manual" ? "Manual" : p.policy === "most-remaining" ? "Most remaining" : p.policy === "round-robin" ? "Round robin" : "Unsupported policy"} · ${p.accountIds.length} accounts`,
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
              !confirm(
                `Revoke ${i.name}? Its session credentials will stop working. Pools and accounts remain available to other clients.`,
              )
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
function editNickname(a) {
  const form = $("nickname-form");
  form.hidden = false;
  form.elements.id.value = a.id;
  form.elements.revision.value = a.revision;
  form.elements.nickname.value = a.nickname ?? "";
  $("nickname-profile").textContent = a.home ?? a.id;
  form.elements.nickname.focus();
}
$("nickname-form").onsubmit = e => {
  e.preventDefault();
  const form = e.currentTarget;
  void run(async () => {
    await api("accounts/set-nickname", { id: form.elements.id.value, revision: Number(form.elements.revision.value), nickname: form.elements.nickname.value });
    form.hidden = true;
    await reload();
  }, form.querySelector("button"));
};
$("cancel-nickname").onclick = () => { $("nickname-form").hidden = true; };
$("providers").onclick = () =>
  run(async () => {
    const result = await api("providers");
    $("provider-status").textContent = result.providers
      .map(
        (p) =>
          `${p.provider}: ${p.available ? (p.version ?? "available") : "not found — install the official CLI"}`,
      )
      .join(" · ");
  }, $("providers"));
$("reload").onclick = () => run(reload, $("reload"));
$("new-pool").onclick = () => {
  if (snapshot) editPool();
};
$("cancel-pool").onclick = () => {
  $("pool-form").hidden = true;
};
$("cancel-grants").onclick = () => {
  $("grant-form").hidden = true;
};
$("pool-form").elements.provider.onchange = () => members();
const accountForm = $("account-form");
let profileGeneration = 0, inspectedProfile;
const profileInput = () => ({ provider: accountForm.elements.provider.value, home: accountForm.elements.home.value, credentialStore: accountForm.elements.credentialStore.value });
function accountSetupChanged() {
  profileGeneration++;
  inspectedProfile = undefined;
  const existing = accountForm.elements.enrollment.value === "existing";
  $("existing-profile").hidden = !existing;
  accountForm.elements.home.required = existing;
  accountForm.elements.home.placeholder = existing ? "/path/to/existing/profile" : "Leave blank to create a dedicated profile";
  $("profile-preview").textContent = "";
  accountForm.querySelector("button[type=submit]").disabled = existing;
}
for (const name of ["enrollment", "provider", "home", "credentialStore"]) accountForm.elements[name].addEventListener("input", accountSetupChanged);
$("discover-profiles").onclick = () => run(async () => {
  const generation = profileGeneration;
  const result = await api("profiles/discover", { provider: accountForm.elements.provider.value });
  if (generation !== profileGeneration) return;
  $("profile-candidates").replaceChildren();
  for (const p of result.profiles) {
    const choice = button(`${p.home}${p.enrolled ? " · already enrolled" : ""}`, () => {
      accountForm.elements.home.value = p.home;
      accountSetupChanged();
    });
    choice.disabled = p.enrolled;
    $("profile-candidates").append(choice);
  }
  if (!result.profiles.length) $("profile-candidates").textContent = "No profiles found. Enter a folder to check it.";
}, $("discover-profiles"));
$("inspect-profile").onclick = () => run(async () => {
  const input = profileInput(), generation = profileGeneration;
  const result = await api("profiles/inspect", input);
  if (generation !== profileGeneration) return;
  $("profile-preview").textContent = `${result.credentialStore} · ${result.credentialStatus} · ${result.detail}`;
  if (result.canEnroll) inspectedProfile = { input: JSON.stringify(input), credentialStore: result.credentialStore };
  accountForm.querySelector("button[type=submit]").disabled = !result.canEnroll;
}, $("inspect-profile"));
accountForm.onsubmit = (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(accountForm));
  void run(async () => {
    if (body.enrollment === "existing") {
      if (inspectedProfile?.input !== JSON.stringify(profileInput())) throw new Error("Check this profile before enrolling it.");
      body.credentialStore = inspectedProfile.credentialStore;
    } else {
      delete body.enrollment;
      delete body.credentialStore;
    }
    if (!body.home) delete body.home;
    await api("accounts/add", body);
    accountForm.reset();
    accountSetupChanged();
    $("profile-candidates").replaceChildren();
    await reload();
  }, accountForm.querySelector("button[type=submit]"));
};
$("pool-form").onsubmit = (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    fields = form.elements;
  void run(async () => {
    await api("pools/save", {
      id: fields.id.value,
      revision: Number(fields.revision.value),
      name: fields.name.value,
      provider: fields.provider.value,
      policy: fields.policy.value,
      accountIds: checked("members"),
    });
    form.hidden = true;
    await reload();
  }, form.querySelector("button[type=submit]"));
};
$("delete-pool").onclick = () =>
  run(async () => {
    const form = $("pool-form");
    if (
      !confirm(
        `Delete ${form.elements.name.value}? Its session pins will stop working. Accounts remain enrolled.`,
      )
    )
      return;
    await api("pools/remove", {
      id: form.elements.id.value,
      revision: Number(form.elements.revision.value),
    });
    form.hidden = true;
    await reload();
  }, $("delete-pool"));
$("grant-form").onsubmit = (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  void run(async () => {
    await api("grants/save", {
      id: form.elements.id.value,
      revision: Number(form.elements.revision.value),
      poolIds: checked("grant-pools"),
      accountIds: checked("grant-accounts"),
    });
    form.hidden = true;
    await reload();
  }, form.querySelector("button[type=submit]"));
};
$("startup").onchange = () =>
  run(async () => {
    const el = $("startup"),
      desired = el.checked;
    try {
      el.checked = await invoke("startup", { enabled: desired });
    } catch (e) {
      el.checked = !desired;
      throw e;
    }
  });
async function checkUpdate() {
  return (updateJob ??= (async () => {
    const result = await invoke("check_update");
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
$("check-update").onclick = () => run(checkUpdate, $("check-update"));
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

$("install-update").onclick = () =>
  run(async () => {
    if (update && confirm(`Install ${update.version} and relaunch? The router must be idle.`))
      await invoke("install_update", { version: update.version });
  }, $("install-update"));
$("stop").onclick = () =>
  run(async () => {
    if (
      !snapshot ||
      !confirm(
        "Stop the router? Idle sessions will be unable to send requests until it is started again. Active requests or sign-ins prevent stopping.",
      )
    )
      return;
    await api("stop", { routerId: snapshot.routerId });
    $("status").textContent = "Router stopped. Reload to start it again.";
  }, $("stop"));
void run(reload);
void invoke("startup", { enabled: null })
  .then((enabled) => {
    $("startup").checked = enabled;
  })
  .catch(error);

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute("aria-controls")).hidden = !selected;
  }
}
for (const tab of tabs) {
  tab.onclick = () => selectTab(tab);
  tab.onkeydown = event => {
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    }
  };
}

$("terminal-presentation").value = localStorage.getItem("terminal-presentation") === "embedded" ? "embedded" : "external";
$("terminal-presentation").onchange = () => localStorage.setItem("terminal-presentation", $("terminal-presentation").value);
