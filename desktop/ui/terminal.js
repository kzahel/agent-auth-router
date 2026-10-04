// This window alone receives ephemeral CLI bytes. No logging or transcript storage.
const $ = id => document.getElementById(id);
const invoke = (action, args = {}) => window.__TAURI__.core.invoke("terminal", { action, ...args });
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => dark.matches
  ? { background: "#191919", foreground: "#ededed", cursor: "#ededed", selectionBackground: "#454545" }
  : { background: "#ffffff", foreground: "#202020", cursor: "#202020", selectionBackground: "#cddfff" };
const terminal = new window.Terminal({
  fontSize: 13, fontFamily: "Menlo, Consolas, monospace", cursorBlink: true,
  scrollback: 500, theme: theme(), allowProposedApi: false,
  linkHandler: { activate: () => {} },
});
const fit = new window.FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open($("terminal"));
// Provider output cannot access the system clipboard via OSC 52.
terminal.parser.registerOscHandler(52, () => true);
let started = false, ended = false, disposed = false, polling, input = Promise.resolve(), queued = 0;
const status = text => { $("terminal-status").textContent = text; };
const dimensions = () => ({ cols: Math.max(20, Math.min(400, terminal.cols)), rows: Math.max(5, Math.min(200, terminal.rows)) });
const resize = () => {
  fit.fit();
  if (started && !ended) void invoke("resize", dimensions()).catch(() => status("Could not resize terminal"));
};
const observer = new ResizeObserver(resize);
observer.observe($("terminal"));
dark.addEventListener("change", () => { terminal.options.theme = theme(); });
terminal.onData(data => {
  if (!started || ended) return;
  const bytes = new TextEncoder().encode(data).length;
  if (queued + bytes > 64 * 1024) { status("Input is busy; paste a smaller amount."); return; }
  queued += bytes;
  input = input.then(async () => {
    const points = Array.from(data);
    for (let i = 0; i < points.length && !ended; i += 1024) await invoke("write", { data: points.slice(i, i + 1024).join("") });
  }).catch(() => status("Terminal input closed")).finally(() => { queued -= bytes; });
});
async function read() {
  try {
    const result = await invoke("read");
    if (disposed) return;
    // Await rendering before reading more; native buffering is independently bounded.
    if (result.bytes.length) await new Promise(resolve => terminal.write(new Uint8Array(result.bytes), resolve));
    if (!result.running && !result.pending) {
      ended = true;
      $("terminal-cancel").disabled = true;
      terminal.options.disableStdin = true;
      status(result.status === "complete" ? "Command finished. Check sign-in in Accounts." : result.status === "failed" ? "Sign-in failed. Review the terminal output." : result.status);
      return;
    }
    polling = setTimeout(read, 50);
  } catch {
    ended = true;
    status("Sign-in connection closed");
  }
}
$("terminal-cancel").onclick = async () => {
  $("terminal-cancel").disabled = true;
  await invoke("cancel").catch(() => {});
  status("Cancelling…");
};
$("terminal-close").onclick = () => window.__TAURI__.window.getCurrentWindow().close();
window.addEventListener("pagehide", () => {
  disposed = true; clearTimeout(polling); observer.disconnect(); terminal.dispose();
  // Native CloseRequested / disconnect watchdog owns process cleanup.
});
try {
  fit.fit();
  const account = await invoke("start", dimensions());
  $("terminal-title").textContent = `${account.provider} sign-in`;
  $("terminal-profile").textContent = account.home;
  started = true; status("Official CLI sign-in is running"); terminal.focus();
  await read();
} catch {
  ended = true; $("terminal-cancel").disabled = true;
  status("Could not start sign-in. Close this window and check the account and installed CLI.");
}
