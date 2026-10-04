//! Bounded local PTY transport. Only the owning sign-in window can access its bytes.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_OUTPUT: usize = 256 * 1024;
const MAX_INPUT: usize = 4096;
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Default)]
pub struct Terminals(
    pub Mutex<HashMap<String, Arc<LoginWindow>>>,
    Mutex<Vec<Arc<LoginPty>>>,
);
pub struct LoginWindow {
    command: Command,
    account: Value,
    pty: Mutex<Option<Arc<LoginPty>>>,
    closed: AtomicBool,
}
pub struct LoginPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    output: Mutex<VecDeque<u8>>,
    status: Mutex<String>,
    running: AtomicBool,
    reader_done: AtomicBool,
    cancelled: AtomicBool,
    cleanup_started: AtomicBool,
    cleanup_done: AtomicBool,
    polled: Mutex<Instant>,
    pid: u32,
}
fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(20..=400).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("Invalid terminal dimensions".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) -> bool {
    // portable-pty creates a fresh session/process group owned by this child.
    pid > 1 && unsafe { libc::kill(-(pid as i32), signal) == 0 }
}
#[cfg(not(unix))]
fn signal_group(_pid: u32, _signal: i32) -> bool {
    false
}
impl LoginPty {
    pub fn spawn(command: &Command, cols: u16, rows: u16) -> Result<Arc<Self>, String> {
        if !cfg!(target_os = "macos") {
            return Err("Embedded sign-in currently supports macOS".into());
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|_| "Cannot create sign-in terminal")?;
        let mut cmd = CommandBuilder::new(command.get_program());
        cmd.args(command.get_args());
        // The Node runner sanitizes the provider environment again before login.
        for (key, value) in command.get_envs() {
            match value {
                Some(value) => cmd.env(key, value),
                None => cmd.env_remove(key),
            };
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env_remove("NODE_OPTIONS");
        cmd.env_remove("NODE_PATH");
        if let Some(cwd) = command.get_current_dir() {
            cmd.cwd(cwd);
        }
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "Cannot read sign-in terminal")?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| "Cannot write sign-in terminal")?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|_| "Cannot start sign-in helper")?;
        drop(pair.slave);
        let pid = child.process_id().ok_or("Missing sign-in process")?;
        let terminal = Arc::new(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            output: Mutex::new(VecDeque::new()),
            status: Mutex::new("running".into()),
            running: AtomicBool::new(true),
            reader_done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cleanup_started: AtomicBool::new(false),
            cleanup_done: AtomicBool::new(false),
            polled: Mutex::new(Instant::now()),
            pid,
        });
        let read_terminal = terminal.clone();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            let mut discard = false;
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                if !discard && !read_terminal.enqueue(&bytes[..count]) {
                    // Keep draining after cancellation: macOS can otherwise leave
                    // a killed writer stuck flushing the terminal during exit.
                    discard = true;
                }
            }
            read_terminal.reader_done.store(true, Ordering::Release);
        });
        let wait_terminal = terminal.clone();
        std::thread::spawn(move || {
            let success = child.wait().is_ok_and(|status| status.success());
            // A provider must not leave descendants behind after its runner exits.
            wait_terminal.cleanup();
            wait_terminal.running.store(false, Ordering::Release);
            let mut status = wait_terminal.status.lock().unwrap();
            if *status == "running" {
                *status = if success { "complete" } else { "failed" }.into();
            }
        });
        let watch_terminal = terminal.clone();
        std::thread::spawn(move || {
            while watch_terminal.running.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_secs(1));
                if watch_terminal.polled.lock().unwrap().elapsed() > Duration::from_secs(15) {
                    watch_terminal.cancel("Sign-in window disconnected");
                }
            }
        });
        Ok(terminal)
    }
    fn enqueue(self: &Arc<Self>, bytes: &[u8]) -> bool {
        let mut output = self.output.lock().unwrap();
        if output.len() + bytes.len() > MAX_OUTPUT {
            output.clear();
            drop(output);
            self.cancel("Output limit reached; sign-in cancelled");
            return false;
        }
        output.extend(bytes);
        true
    }
    pub fn cancel(self: &Arc<Self>, reason: &str) {
        if !self.running.load(Ordering::Acquire) || self.cancelled.swap(true, Ordering::AcqRel) {
            return;
        }
        *self.status.lock().unwrap() = reason.into();
        self.cleanup();
    }
    fn cleanup(self: &Arc<Self>) {
        if self.cleanup_started.swap(true, Ordering::AcqRel) {
            return;
        }
        if !signal_group(self.pid, libc::SIGTERM) {
            self.cleanup_done.store(true, Ordering::Release);
            return;
        }
        let terminal = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            // The owned process group can outlive its leader.
            terminal.finish_cleanup();
        });
    }
    fn finish_cleanup(&self) {
        // Never retain authority over a numeric process group after cleanup ends.
        if !self.cleanup_done.swap(true, Ordering::AcqRel) {
            signal_group(self.pid, libc::SIGKILL);
        }
    }
    fn write(&self, data: &str) -> Result<(), String> {
        if data.len() > MAX_INPUT {
            return Err("Paste at most 4096 bytes at a time".into());
        }
        if !self.running.load(Ordering::Acquire) || self.cancelled.load(Ordering::Acquire) {
            return Err("Sign-in has ended".into());
        }
        self.writer
            .lock()
            .map_err(|_| "Terminal unavailable")?
            .write_all(data.as_bytes())
            .map_err(|_| "Terminal input closed".into())
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .map_err(|_| "Terminal unavailable")?
            .resize(size(cols, rows)?)
            .map_err(|_| "Cannot resize terminal".into())
    }
    fn read(&self) -> Value {
        *self.polled.lock().unwrap() = Instant::now();
        let mut output = self.output.lock().unwrap();
        let count = output.len().min(32 * 1024);
        let bytes: Vec<u8> = output.drain(..count).collect();
        json!({ "bytes": bytes, "running": self.running.load(Ordering::Acquire) || !self.reader_done.load(Ordering::Acquire), "status": *self.status.lock().unwrap(), "pending": !output.is_empty() })
    }
}
impl LoginWindow {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(pty) = self.pty.lock().unwrap().as_ref() {
            pty.cancel("cancelled");
        }
    }
}
impl Terminals {
    pub fn close(&self, label: &str) {
        if let Some(window) = self.0.lock().unwrap().remove(label) {
            window.close();
            if let Some(pty) = window.pty.lock().unwrap().as_ref() {
                let mut closing = self.1.lock().unwrap();
                closing.retain(|p| !p.cleanup_done.load(Ordering::Acquire));
                if !pty.cleanup_done.load(Ordering::Acquire) {
                    closing.push(pty.clone());
                }
            }
        }
    }
    pub fn close_all(&self) {
        let windows: Vec<_> = self.0.lock().unwrap().drain().map(|(_, w)| w).collect();
        let mut processes: Vec<_> = self.1.lock().unwrap().drain(..).collect();
        for window in windows {
            window.close();
            if let Some(pty) = window.pty.lock().unwrap().as_ref() {
                processes.push(pty.clone());
            }
        }
        // ExitRequested must finish cleanup before app exit stops background threads.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && processes
                .iter()
                .any(|p| !p.cleanup_done.load(Ordering::Acquire) && signal_group(p.pid, 0))
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        for process in processes {
            process.finish_cleanup();
        }
    }
    pub fn busy(&self) -> bool {
        self.0.lock().unwrap().values().any(|w| {
            w.pty
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|p| p.running.load(Ordering::Acquire))
        })
    }
}
pub fn open(app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    let overview = super::request(app, "overview", json!({}))?;
    let account = overview["accounts"]
        .as_array()
        .and_then(|accounts| {
            accounts
                .iter()
                .find(|a| a["id"] == id && a["enabled"] == true && a["retired"] != true)
        })
        .ok_or("Account unavailable")?;
    let mut command = super::command(app)?;
    command.arg("terminal-login").arg(id);
    command.current_dir(super::state_dir(app)?);
    let terminals = app.state::<Terminals>();
    let mut windows = terminals.0.lock().map_err(|_| "Terminal unavailable")?;
    if windows.len() >= 4 {
        return Err("Close a sign-in window before opening another".into());
    }
    if windows.values().any(|w| w.account["id"] == id) {
        return Err("This account already has a sign-in window".into());
    }
    let label = format!("signin-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    windows.insert(
        label.clone(),
        Arc::new(LoginWindow {
            command,
            account: json!({ "id": id, "provider": account["provider"], "home": account["home"] }),
            pty: Mutex::new(None),
            closed: AtomicBool::new(false),
        }),
    );
    drop(windows);
    if WebviewWindowBuilder::new(app, &label, WebviewUrl::App("terminal.html".into()))
        .title("Sign in · Agent Auth Router")
        .inner_size(740.0, 480.0)
        .min_inner_size(520.0, 340.0)
        .on_navigation(|url| {
            ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
                && url.path() == "/terminal.html"
        })
        .build()
        .is_err()
    {
        terminals.close(&label);
        return Err("Could not open sign-in window".into());
    }
    Ok(json!({ "opened": true, "presentation": "embedded" }))
}
#[tauri::command]
pub async fn terminal(
    window: tauri::WebviewWindow,
    action: String,
    data: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Value, String> {
    // The caller's native window identity selects the session; JS cannot supply an id.
    let login = window
        .state::<Terminals>()
        .0
        .lock()
        .map_err(|_| "Terminal unavailable")?
        .get(window.label())
        .cloned()
        .ok_or("Not a sign-in window")?;
    tauri::async_runtime::spawn_blocking(move || {
        if login.closed.load(Ordering::Acquire) {
            return Err("Sign-in window closed".into());
        }
        let mut current = login.pty.lock().map_err(|_| "Terminal unavailable")?;
        // Close can race an IPC task between its initial check and this lock.
        if login.closed.load(Ordering::Acquire) {
            return Err("Sign-in window closed".into());
        }
        if action == "start" {
            if current.is_some() {
                return Err("Sign-in already started".into());
            }
            *current = Some(LoginPty::spawn(
                &login.command,
                cols.unwrap_or(80),
                rows.unwrap_or(24),
            )?);
            return Ok(login.account.clone());
        }
        let pty = current.as_ref().ok_or("Sign-in has not started")?.clone();
        drop(current);
        match action.as_str() {
            "read" => Ok(pty.read()),
            "write" => {
                pty.write(data.as_deref().unwrap_or(""))?;
                Ok(json!({}))
            }
            "resize" => {
                pty.resize(cols.unwrap_or(80), rows.unwrap_or(24))?;
                Ok(json!({}))
            }
            "cancel" => {
                pty.cancel("cancelled");
                Ok(json!({}))
            }
            _ => Err("Unknown terminal operation".into()),
        }
    })
    .await
    .map_err(|_| "Terminal task failed")?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    fn until(mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if check() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("PTY fixture deadline");
    }
    fn drain(pty: &LoginPty, output: &mut String) {
        let bytes: Vec<u8> = pty.read()["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        output.push_str(&String::from_utf8_lossy(&bytes));
    }
    struct Guard(Arc<LoginPty>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.cancel("test cleanup");
        }
    }
    #[test]
    fn pty_has_interactive_input_dimensions_and_bounded_transport() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "test -t 0 && test -t 1 && printf 'TTY_READY\\n'; read answer; stty size; printf 'ANSWER:%s\\n' \"$answer\""]);
        let pty = LoginPty::spawn(&command, 80, 24).unwrap();
        let _guard = Guard(pty.clone());
        let mut output = String::new();
        until(|| {
            drain(&pty, &mut output);
            output.contains("TTY_READY")
        });
        assert!(pty.write(&"x".repeat(MAX_INPUT + 1)).is_err());
        assert!(pty.resize(0, 0).is_err());
        pty.resize(90, 30).unwrap();
        pty.write("yes\n").unwrap();
        until(|| {
            drain(&pty, &mut output);
            !pty.read()["running"].as_bool().unwrap()
        });
        drain(&pty, &mut output);
        assert!(output.contains("30 90"), "{output}");
        assert!(output.contains("ANSWER:yes"));
        assert_eq!(pty.read()["status"], "complete");
        assert!(pty.write("late").is_err());
    }
    #[test]
    fn cancelled_pty_kills_stubborn_process_group() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "trap '' TERM HUP; sleep 90 & printf 'CHILD:%s\\n' $!; wait",
        ]);
        let pty = LoginPty::spawn(&command, 80, 24).unwrap();
        let _guard = Guard(pty.clone());
        let mut output = String::new();
        until(|| {
            drain(&pty, &mut output);
            output.contains("CHILD:")
        });
        let child: i32 = output
            .split("CHILD:")
            .nth(1)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        pty.cancel("cancelled");
        until(|| !pty.running.load(Ordering::Acquire));
        until(|| unsafe { libc::kill(child, 0) != 0 });
        assert_eq!(pty.read()["status"], "cancelled");
    }
    #[test]
    fn application_exit_finishes_process_group_cleanup() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "trap '' TERM HUP; printf 'READY\\n'; while :; do sleep 90; done",
        ]);
        let pty = LoginPty::spawn(&command, 80, 24).unwrap();
        let _guard = Guard(pty.clone());
        let mut output = String::new();
        until(|| {
            drain(&pty, &mut output);
            output.contains("READY")
        });
        let terminals = Terminals::default();
        terminals.0.lock().unwrap().insert(
            "signin-test".into(),
            Arc::new(LoginWindow {
                command,
                account: json!({"id":"synthetic"}),
                pty: Mutex::new(Some(pty.clone())),
                closed: AtomicBool::new(false),
            }),
        );
        // Quit immediately after the sign-in window closes must still escalate.
        terminals.close("signin-test");
        terminals.close_all();
        until(|| !signal_group(pty.pid, 0));
        assert!(terminals.0.lock().unwrap().is_empty());
        assert!(pty.cancelled.load(Ordering::Acquire));
    }
    #[test]
    fn successful_runner_does_not_leave_stubborn_descendants() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "trap '' TERM HUP; sleep 90 & printf 'CHILD:%s\\n' $!; exit 0",
        ]);
        let pty = LoginPty::spawn(&command, 80, 24).unwrap();
        let _guard = Guard(pty.clone());
        let mut output = String::new();
        until(|| {
            drain(&pty, &mut output);
            output.contains("CHILD:")
        });
        let child: i32 = output
            .split("CHILD:")
            .nth(1)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        until(|| unsafe { libc::kill(child, 0) != 0 });
        until(|| !pty.read()["running"].as_bool().unwrap());
        assert_eq!(pty.read()["status"], "complete");
    }
    #[test]
    fn flood_and_disconnected_windows_cancel_without_unbounded_retention() {
        for flood in [true, false] {
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                if flood {
                    "yes synthetic-terminal-output"
                } else {
                    "sleep 90"
                },
            ]);
            let pty = LoginPty::spawn(&command, 80, 24).unwrap();
            let _guard = Guard(pty.clone());
            if !flood {
                *pty.polled.lock().unwrap() = Instant::now() - Duration::from_secs(20);
            }
            until(|| !pty.running.load(Ordering::Acquire));
            assert!(pty.output.lock().unwrap().len() <= MAX_OUTPUT);
            assert!(pty.cancelled.load(Ordering::Acquire));
        }
    }
    struct CoreFixture {
        root: std::path::PathBuf,
        node: std::path::PathBuf,
        cli: std::path::PathBuf,
        child: std::process::Child,
    }
    impl CoreFixture {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;
            let root = std::env::temp_dir().join(format!(
                "aar-native-signin-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join("bin")).unwrap();
            std::fs::write(
                root.join("config.json"),
                r#"{"listen":{"host":"127.0.0.1","port":0}}"#,
            )
            .unwrap();
            let resources =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources");
            let node = resources.join("node");
            let cli = resources.join("core/cli.js");
            assert!(
                node.exists() && cli.exists(),
                "Run prepare:bundle before native acceptance tests"
            );
            let fake = root.join("fake.mjs");
            std::fs::write(
                &fake,
                r#"
import {writeFileSync} from 'node:fs';
const home=process.env.CODEX_HOME??process.env.CLAUDE_CONFIG_DIR;
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);
if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENAI_API_KEY) process.exit(3);
writeFileSync(home+'/probe.json', JSON.stringify({args:process.argv.slice(2),home}));
console.log('SYNTHETIC_CONFIRM');
process.stdin.once('data',()=>process.exit(0));
"#,
            )
            .unwrap();
            for provider in ["claude", "codex"] {
                let path = root.join("bin").join(provider);
                std::fs::write(
                    &path,
                    format!(
                        "#!/bin/sh\nexec {} {} \"$@\"\n",
                        super::super::shell_quote(&node.to_string_lossy()),
                        super::super::shell_quote(&fake.to_string_lossy())
                    ),
                )
                .unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            let child = Command::new(&node)
                .arg(&cli)
                .args(["--state"])
                .arg(&root)
                .arg("serve")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let fixture = Self {
                root,
                node,
                cli,
                child,
            };
            until(|| fixture.root.join("control.sock").exists());
            fixture
        }
        fn owner(&self, operation: &str, body: Value) -> Result<Value, String> {
            let mut child = Command::new(&self.node)
                .arg(&self.cli)
                .arg("--state")
                .arg(&self.root)
                .args(["owner-request", operation])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(body.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            if !output.status.success() {
                return Err("owner refused".into());
            }
            Ok(serde_json::from_slice(&output.stdout).unwrap())
        }
        fn login(&self, id: &str) -> Arc<LoginPty> {
            let mut command = Command::new(&self.node);
            command
                .arg(&self.cli)
                .arg("--state")
                .arg(&self.root)
                .args(["terminal-login", id]);
            command.env(
                "PATH",
                format!("{}:/usr/bin:/bin", self.root.join("bin").display()),
            );
            command
                .env("ANTHROPIC_AUTH_TOKEN", "synthetic-poison")
                .env("OPENAI_API_KEY", "synthetic-poison");
            LoginPty::spawn(&command, 80, 24).unwrap()
        }
    }
    impl Drop for CoreFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn native_pty_runs_both_official_login_fixtures_through_the_real_router_lease() {
        let fixture = CoreFixture::new();
        for provider in ["claude", "codex"] {
            fixture
                .owner(
                    "accounts/add",
                    json!({"id":provider,"provider":provider,"credentialStore":"file"}),
                )
                .unwrap();
            let pty = fixture.login(provider);
            let _guard = Guard(pty.clone());
            let mut output = String::new();
            until(|| {
                drain(&pty, &mut output);
                output.contains("Choose [1/2]")
            });
            let overview = fixture.owner("overview", json!({})).unwrap();
            assert!(fixture
                .owner("stop", json!({"routerId":overview["routerId"]}))
                .is_err());
            assert!(fixture
                .owner("accounts/login", json!({"id":provider}))
                .is_err());
            pty.write("2\n").unwrap();
            until(|| {
                drain(&pty, &mut output);
                output.contains("SYNTHETIC_CONFIRM")
            });
            pty.write("yes\n").unwrap();
            until(|| {
                drain(&pty, &mut output);
                !pty.read()["running"].as_bool().unwrap()
            });
            assert_eq!(pty.read()["status"], "complete", "{output}");
            assert_eq!(
                fixture
                    .owner("accounts/login-status", json!({"id":provider}))
                    .unwrap()["loginStatus"],
                "complete"
            );
            let probe: Value = serde_json::from_slice(
                &std::fs::read(
                    fixture
                        .root
                        .join("profiles")
                        .join(provider)
                        .join("probe.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                probe["args"],
                if provider == "codex" {
                    json!(["login", "--device-auth"])
                } else {
                    json!(["auth", "login", "--claudeai", "--sso"])
                }
            );
            assert!(!overview.to_string().contains("SYNTHETIC_CONFIRM"));
        }
        // Closing an embedded window while choosing a method releases the same lease.
        let pty = fixture.login("codex");
        let _guard = Guard(pty.clone());
        let mut output = String::new();
        until(|| {
            drain(&pty, &mut output);
            output.contains("Choose [1/2]")
        });
        pty.cancel("cancelled");
        until(|| !pty.running.load(Ordering::Acquire));
        until(|| {
            fixture
                .owner("accounts/login-status", json!({"id":"codex"}))
                .is_ok_and(|v| v["loginStatus"] != "running")
        });
    }
}
