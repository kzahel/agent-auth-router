#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app_pipe;
mod lifecycle;
#[cfg(debug_assertions)]
mod smoke;
mod terminal;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct Core {
    child: Option<Child>,
    diagnostics: lifecycle::Diagnostics,
}
// Quit state: 0 running, 1 stopping, 2 allowed to exit.
struct Runtime(Mutex<Core>, AtomicBool, AtomicU8);
struct Updating(tauri::AppHandle);
impl Drop for Updating {
    fn drop(&mut self) {
        self.0.state::<Runtime>().1.store(false, Ordering::Release);
    }
}
fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"))
    } else {
        app.path()
            .resource_dir()
            .map(|p| p.join("resources"))
            .map_err(|_| "Cannot locate bundled runtime".into())
    }
}
fn state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Explicit test override; production defaults to the headless CLI's profile.
    if let Some(path) = std::env::var_os("AAR_STATE_DIR") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .home_dir()
        .map(|p| p.join(".agent-auth-router"))
        .map_err(|_| "Cannot locate home directory".into())
}
fn command(app: &tauri::AppHandle) -> Result<Command, String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "This candidate supports macOS; Windows authority and lifecycle adapters are pending."
                .into(),
        );
    }
    let resource = resources(app)?;
    let mut command = Command::new(resource.join("node"));
    command
        .arg(resource.join("core/cli.js"))
        .arg("--state")
        .arg(state_dir(app)?);
    // Finder has a minimal PATH. Discover official CLIs in customary user locations.
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot locate home directory")?;
    let inherited = std::env::var("PATH").unwrap_or_default();
    command.env(
        "PATH",
        format!(
            "{}:{}/.local/bin:{}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
            resource.display(),
            home.display(),
            home.display(),
            inherited
        ),
    );
    #[cfg(debug_assertions)]
    if std::env::var("AAR_SIGNIN_SMOKE").as_deref() == Ok("1")
        || std::env::var("AAR_LIFECYCLE_SMOKE").as_deref() == Ok("1")
    {
        if !smoke::enabled() {
            return Err("Synthetic smoke profile required".into());
        }
        command.env(
            "PATH",
            format!(
                "{}:{}",
                state_dir(app)?.join("bin").display(),
                resource.display()
            ),
        );
    }
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    Ok(command)
}
/// Owner operations for lifecycle work go over the core's private app socket.
fn request(app: &tauri::AppHandle, operation: &str, body: Value) -> Result<Value, String> {
    let state = state_dir(app)?;
    match app_pipe::call(&state, operation, body.clone()) {
        // A router started by an earlier release has only its control socket.
        Err(error) if error.contains("ENOENT") && state.join("control.sock").exists() => {
            cli_request(app, operation, body)
        }
        result => result,
    }
}
fn cli_request(app: &tauri::AppHandle, operation: &str, body: Value) -> Result<Value, String> {
    let mut child = command(app)?
        .arg("owner-request")
        .arg(operation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Bundled router could not start")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.to_string().as_bytes())
            .map_err(|_| "Router request failed")?;
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Router request failed")?;
    if !output.status.success() {
        // The bridge prints only ControlError / known transport failures, never provider output.
        return Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .trim_start_matches("aar: ")
            .to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid router response".into())
}
fn ensure_core(app: &tauri::AppHandle, core: &mut Core) -> Result<Value, String> {
    if let Ok(value) = request(app, "overview", json!({})) {
        if core
            .child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_some())
        {
            core.child = None;
        }
        return Ok(value);
    }
    if let Some(child) = core.child.as_mut() {
        if child
            .try_wait()
            .map_err(|_| "Cannot inspect router process")?
            .is_none()
        {
            return Err("Router is starting or unavailable. Reload to retry.".into());
        }
    }
    let mut child = command(app)?
        .arg("desktop-serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start bundled router: {e}"))?;
    core.diagnostics = lifecycle::Diagnostics::capture(
        child
            .stderr
            .take()
            .ok_or("Cannot capture startup diagnostics")?,
    );
    core.child = Some(child);
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(value) = request(app, "overview", json!({})) {
            return Ok(value);
        }
        if let Some(child) = core.child.as_mut() {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot inspect router process")?
            {
                return Err(core.diagnostics.exited(status));
            }
        }
    }
    Err("Router did not become ready".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_launcher_quotes_paths_without_shell_expansion() {
        let path = "/tmp/profile ' $(touch sentinel) `echo unsafe`";
        let script = terminal_script("/node", "/cli.js", path, "account-id", "/bin");
        assert!(script.contains("terminal-login 'account-id'"));
        let quoted = shell_quote(path);
        let output = Command::new("/bin/sh")
            .args(["-c", &format!("printf %s {}", quoted)])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), path);
    }
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn terminal_script(node: &str, cli: &str, state: &str, id: &str, path: &str) -> String {
    format!("#!/bin/bash\n# Generated by Agent Auth Router; contains no credentials.\n/bin/rm -- \"$0\"\nunset NODE_OPTIONS NODE_PATH\nexport PATH={}\nexec {} {} --state {} terminal-login {}\n", shell_quote(path), shell_quote(node), shell_quote(cli), shell_quote(state), shell_quote(id))
}
#[cfg(target_os = "macos")]
fn open_terminal(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let overview = request(app, "overview", json!({}))?;
    if !overview["accounts"].as_array().is_some_and(|accounts| {
        accounts
            .iter()
            .any(|a| a["id"] == id && a["enabled"] == true && a["retired"] != true)
    }) {
        return Err("Account is unavailable".into());
    }
    let resource = resources(app)?;
    let state = state_dir(app)?;
    let directory = state.join("terminal-launches");
    fs::create_dir_all(&directory).map_err(|_| "Cannot prepare terminal launcher")?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Cannot protect terminal launcher")?;
    let name = format!(
        "login-{}-{}.command",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Invalid clock")?
            .as_nanos()
    );
    let file = directory.join(name);
    let command = command(app)?;
    let path = command
        .get_envs()
        .find(|(k, _)| *k == "PATH")
        .and_then(|(_, v)| v)
        .ok_or("Missing CLI search path")?;
    let script = terminal_script(
        &resource.join("node").to_string_lossy(),
        &resource.join("core/cli.js").to_string_lossy(),
        &state.to_string_lossy(),
        id,
        &path.to_string_lossy(),
    );
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&file)
        .and_then(|mut f| f.write_all(script.as_bytes()))
        .map_err(|_| "Cannot write terminal launcher")?;
    let opened = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.Terminal"])
        .arg(&file)
        .status()
        .map_err(|_| "Could not open Terminal")?;
    if !opened.success() {
        let _ = fs::remove_file(file);
        return Err("Could not open Terminal".into());
    }
    // Terminal launches asynchronously. Give its runner time to acquire the
    // owner lease so the next UI reload can show Cancel sign-in.
    for _ in 0..30 {
        if let Ok(value) = request(app, "overview", json!({})) {
            if value["logins"].as_array().is_some_and(|logins| {
                logins
                    .iter()
                    .any(|l| l["id"] == id && l["status"] == "running")
            }) {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(json!({"opened": true}))
}
#[cfg(not(target_os = "macos"))]
fn open_terminal(_app: &tauri::AppHandle, _id: &str) -> Result<Value, String> {
    Err("Terminal sign-in is currently supported on macOS".into())
}
fn lifecycle_ready(runtime: &Runtime) -> Result<(), String> {
    if runtime.2.load(Ordering::Acquire) != 0 {
        return Err("Router is shutting down".into());
    }
    if runtime.1.load(Ordering::Acquire) {
        return Err("Update installation is in progress".into());
    }
    Ok(())
}
/// Opens the webview's connection to the core. `start` also starts a stopped
/// core; automatic reconnection never does, so Stop router stays stopped.
#[tauri::command]
async fn app_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    start: bool,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Runtime>();
        lifecycle_ready(&runtime)?;
        if start {
            let mut core = runtime
                .0
                .lock()
                .map_err(|_| "Router lifecycle unavailable")?;
            lifecycle_ready(&runtime)?;
            ensure_core(&app, &mut core)?;
        }
        let emitter = app.clone();
        app.state::<app_pipe::Pipe>()
            .open(&state_dir(&app)?, move |message| {
                let _ = match message {
                    Some(message) => emitter.emit_to("main", "app-message", message),
                    None => emitter.emit_to("main", "app-closed", ()),
                };
            })
            .map_err(|error| {
                if error.contains("ENOENT")
                    && state_dir(&app).is_ok_and(|s| s.join("control.sock").exists())
                {
                    "This router was started by an earlier version. Stop it, then Reload.".into()
                } else {
                    error
                }
            })
    })
    .await
    .map_err(|_| "Router task failed")?
}
#[tauri::command]
async fn app_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    message: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    app.state::<app_pipe::Pipe>().send(&message)
}
/// Synthetic smoke helper: one owner call from the main window.
#[cfg(debug_assertions)]
#[tauri::command]
async fn app_call(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    operation: String,
    body: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    tauri::async_runtime::spawn_blocking(move || request(&app, &operation, body))
        .await
        .map_err(|_| "Router task failed")?
}
#[tauri::command]
async fn terminal_login(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    presentation: String,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Runtime>();
        let _core = runtime
            .0
            .lock()
            .map_err(|_| "Router lifecycle unavailable")?;
        lifecycle_ready(&runtime)?;
        match presentation.as_str() {
            "external" => open_terminal(&app, &id),
            "embedded" => terminal::open(&app, &id),
            _ => Err("Unsupported terminal presentation".into()),
        }
    })
    .await
    .map_err(|_| "Router task failed")?
}
#[tauri::command]
fn startup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: Option<bool>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    let manager = app.autolaunch();
    if let Some(enabled) = enabled {
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|_| "Could not change launch at login")?;
    }
    manager
        .is_enabled()
        .map_err(|_| "Could not read launch at login".into())
}
#[tauri::command]
async fn check_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    #[cfg(debug_assertions)]
    if smoke::update_enabled() {
        return Ok(json!({ "version": "0.1.999" }));
    }
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Updater is not configured")?
        .check()
        .await
        .map_err(|_| "Update service unavailable. Try again later.")?;
    Ok(match update {
        Some(u) => json!({ "version": u.version, "notes": u.body }),
        None => json!({ "current": true }),
    })
}
#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    version: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Owner window required".into());
    }
    #[cfg(debug_assertions)]
    if smoke::update_enabled() {
        std::fs::write(state_dir(&app)?.join("update-invoked"), version)
            .map_err(|_| "Cannot record update smoke")?;
        return Err("Synthetic download failure".into());
    }
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Updater is not configured")?
        .check()
        .await
        .map_err(|_| "Update check failed")?
        .ok_or("Update no longer available")?;
    if update.version != version {
        return Err("Update changed. Check again before installing.".into());
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|_| "Signed update download failed")?;
    app.state::<Runtime>()
        .1
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Update installation is already in progress")?;
    let _updating = Updating(app.clone());
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = handle.state::<Runtime>();
        let _core = runtime
            .0
            .lock()
            .map_err(|_| "Router lifecycle unavailable")?;
        if handle.state::<terminal::Terminals>().busy() {
            return Err("Close sign-in windows before updating".into());
        }
        let status = request(&handle, "overview", json!({}))?;
        request(&handle, "stop", json!({ "routerId": status["routerId"] }))?;
        // Wait for private IPC release before replacing the runtime.
        for _ in 0..100 {
            if !state_dir(&handle)?.join("control.sock").exists() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err::<(), String>("Router has not stopped; update was not installed".into())
    })
    .await
    .map_err(|_| "Router stop failed")??;
    if update.install(bytes).is_err() {
        return Err("Update installation failed. Reload to restart the existing router.".into());
    }
    app.restart();
}
fn stop_for_quit(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let mut core = runtime
        .0
        .lock()
        .map_err(|_| "Router lifecycle unavailable")?;
    if core
        .child
        .as_mut()
        .is_some_and(|child| child.try_wait().ok().flatten().is_some())
    {
        core.child = None;
    }
    if let Some(child) = core.child.as_mut() {
        // Closing the app's private pipe requests forced router cleanup, including
        // active streams and official login helpers. This also works after a crash.
        drop(child.stdin.take());
        for _ in 0..120 {
            if child
                .try_wait()
                .map_err(|_| "Cannot inspect router process")?
                .is_some()
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        child.kill().map_err(|_| "Cannot stop router process")?;
        child.wait().map_err(|_| "Cannot reap router process")?;
        return Ok(());
    }
    let socket = state_dir(app)?.join("control.sock");
    if !socket.exists() {
        return Ok(());
    }
    let status = match request(app, "overview", json!({})) {
        Ok(status) => status,
        Err(error) if error.contains("ECONNREFUSED") || error.contains("ENOENT") => return Ok(()),
        Err(error) => return Err(format!("Could not stop the router: {error}")),
    };
    let body = json!({"routerId": status["routerId"]});
    if let Err(error) = request(app, "shutdown", body.clone()) {
        // Earlier releases only understand idle stop. Never silently leave them running.
        if !error.contains("unknown owner operation") {
            return Err(error);
        }
        request(app, "stop", body)?;
    }
    for _ in 0..120 {
        if !socket.exists() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Router has not stopped. Try Quit again.".into())
}
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Runtime(
            Mutex::new(Core::default()),
            AtomicBool::new(false),
            AtomicU8::new(0),
        ))
        .manage(terminal::Terminals::default())
        .manage(app_pipe::Pipe::default());
    #[cfg(debug_assertions)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            app_connect,
            app_send,
            app_call,
            terminal_login,
            startup,
            check_update,
            install_update,
            terminal::terminal,
            smoke::smoke_result,
            smoke::smoke_window,
            smoke::smoke_ready
        ])
        .on_page_load(smoke::loaded);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_connect,
        app_send,
        terminal_login,
        startup,
        check_update,
        install_update,
        terminal::terminal
    ]);
    builder
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Accounts & Pools", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("Missing tray icon")?
                        .clone(),
                )
                .menu(&menu)
                .tooltip("Agent Auth Router")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let runtime = handle.state::<Runtime>();
                if let Ok(mut core) = runtime.0.lock() {
                    if runtime.2.load(Ordering::Acquire) == 0 {
                        let _ = ensure_core(&handle, &mut core);
                    }
                };
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.state::<terminal::Terminals>().close(window.label());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not run Agent Auth Router")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let runtime = app.state::<Runtime>();
                if runtime.2.load(Ordering::Acquire) == 2 {
                    return;
                }
                api.prevent_exit();
                if runtime
                    .2
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return;
                }
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    handle.state::<terminal::Terminals>().close_all();
                    handle.state::<app_pipe::Pipe>().close();
                    match stop_for_quit(&handle) {
                        Ok(()) => {
                            // An in-flight open may have finished while shutdown
                            // waited for the router lock. Drain it before exiting.
                            handle.state::<terminal::Terminals>().close_all();
                            handle.state::<Runtime>().2.store(2, Ordering::Release);
                            handle.exit(code.unwrap_or(0));
                        }
                        Err(error) => {
                            handle.state::<Runtime>().2.store(0, Ordering::Release);
                            show(&handle);
                            let _ = handle.emit_to("main", "router-lifecycle-error", error);
                        }
                    }
                });
            }
        });
}
