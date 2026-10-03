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
function members(selected = []) {
  $("members").replaceChildren();
  for (const a of snapshot.accounts.filter(
    (a) => a.provider === $("pool-form").elements.provider.value,
  ))
    check($("members"), a.id, `${a.id}${a.enabled ? "" : " · disabled"}`, selected.includes(a.id));
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
    : "Manual selects an account explicitly. Round robin requires fresh quota and model observations; refresh members before automatic allocation.";
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
    check($("grant-accounts"), a.id, a.id, integration.accountIds.includes(a.id));
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
      element("h3", a.id),
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
          `${w.bucket} · ${w.usedPercent === null ? "unknown" : `${w.usedPercent}% used`}`,
        ),
      );
      const bar = element("progress");
      bar.max = 100;
      if (w.usedPercent !== null) bar.value = w.usedPercent;
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
        element("p", "Usage has not been observed. Refresh to check quota and models.", "hint"),
      );
    if (a.error || a.blocked) card.append(element("p", a.blocked ?? a.error, "unknown"));
    const login = next.logins.find((l) => l.id === a.id);
    if (login) card.append(element("p", `Sign-in: ${login.status}`, "hint"));
    const actions = element("div", undefined, "actions");
    actions.append(
      button("Sign in", async () => {
        await api("accounts/login", { id: a.id });
        await reload();
      }),
      button("Check sign-in", async () => {
        const s = await api("accounts/login-status", { id: a.id });
        card.append(
          element("p", `Credentials: ${s.credentialStatus} · sign-in ${s.loginStatus}`, "hint"),
        );
        if (s.canOpenLogin)
          card.append(button("Open sign-in page", () => api("accounts/open-login", { id: a.id })));
      }),
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
        `${p.provider} · ${p.policy === "manual" ? "Manual" : "Round robin"} · ${p.accountIds.length} accounts`,
        "badge",
      ),
      element("p", p.accountIds.join(", "), "hint"),
      button("Edit pool", () => editPool(p)),
    );
    $("pools").append(card);
  }
  if (!next.pools.length)
    $("pools").append(
      element("p", "Create a Work pool, then grant an integration access.", "hint"),
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
    $("integrations").append(element("p", "No integrations connected yet.", "hint"));
}
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
$("account-form").onsubmit = (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    body = Object.fromEntries(new FormData(form));
  void run(async () => {
    await api("accounts/add", body);
    form.reset();
    await reload();
  }, form.querySelector("button"));
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
