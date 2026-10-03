#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_updater::UpdaterExt;

struct Core {
    child: Option<Child>,
}
struct Runtime(Mutex<Core>, AtomicBool);
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
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    Ok(command)
}
fn request(app: &tauri::AppHandle, operation: &str, body: Value) -> Result<Value, String> {
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
    core.child = Some(
        command(app)?
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot start bundled router")?,
    );
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(value) = request(app, "overview", json!({})) {
            return Ok(value);
        }
        if let Some(child) = core.child.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "Cannot inspect router process")?
                .is_some()
            {
                return Err("Router could not start. Another process or stale control socket may own this profile; inspect it with the CLI before removing anything.".into());
            }
        }
    }
    Err("Router did not become ready".into())
}
fn enrollment_body(operation: &str, mut body: Value) -> Value {
    // Official Claude Code uses the profile-scoped Keychain on macOS.
    // Keep the headless API's explicit/file defaults unchanged.
    if cfg!(target_os = "macos")
        && operation == "accounts/add"
        && body["provider"] == "claude"
        && body.get("credentialStore").is_none()
    {
        body["credentialStore"] = json!("claude-keychain");
    }
    body
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_enrollment_selects_profile_keychain_only_for_claude() {
        let claude = enrollment_body("accounts/add", json!({"provider": "claude"}));
        if cfg!(target_os = "macos") {
            assert_eq!(claude["credentialStore"], "claude-keychain");
        }
        assert!(
            enrollment_body("accounts/add", json!({"provider": "codex"}))["credentialStore"]
                .is_null()
        );
        assert_eq!(
            enrollment_body(
                "accounts/add",
                json!({"provider": "claude", "credentialStore": "file"})
            )["credentialStore"],
            "file"
        );
    }
}
#[tauri::command]
async fn router(app: tauri::AppHandle, operation: String, body: Value) -> Result<Value, String> {
    const OPERATIONS: &[&str] = &[
        "overview",
        "providers",
        "accounts/add",
        "accounts/set-enabled",
        "accounts/retire",
        "accounts/refresh",
        "accounts/login",
        "accounts/login-status",
        "accounts/open-login",
        "accounts/cancel-login",
        "pools/save",
        "pools/remove",
        "grants/save",
        "integrations/revoke",
        "stop",
    ];
    if !OPERATIONS.contains(&operation.as_str()) {
        return Err("Unknown desktop operation".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Runtime>();
        let mut core = runtime
            .0
            .lock()
            .map_err(|_| "Router lifecycle unavailable")?;
        if runtime.1.load(Ordering::Acquire) {
            return Err("Update installation is in progress".into());
        }
        if operation == "overview" {
            return ensure_core(&app, &mut core);
        }
        request(&app, &operation, enrollment_body(&operation, body))
    })
    .await
    .map_err(|_| "Router task failed")?
}
#[tauri::command]
fn startup(app: tauri::AppHandle, enabled: Option<bool>) -> Result<bool, String> {
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
async fn check_update(app: tauri::AppHandle) -> Result<Value, String> {
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
async fn install_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
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
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Runtime(
            Mutex::new(Core { child: None }),
            AtomicBool::new(false),
        ))
        .invoke_handler(tauri::generate_handler![
            router,
            startup,
            check_update,
            install_update
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Accounts & Pools", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit App (Keep Router Running)",
                true,
                None::<&str>,
            )?;
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
                    let _ = ensure_core(&handle, &mut core);
                };
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not run Agent Auth Router");
}
