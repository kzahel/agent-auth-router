//! Startup diagnostics are bounded, ephemeral and restricted to the CLI's safe envelope.
use std::{
    io::Read,
    process::ChildStderr,
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
#[derive(Default)]
pub struct Diagnostics {
    bytes: Arc<Mutex<Vec<u8>>>,
    reader: Option<JoinHandle<()>>,
}
impl Diagnostics {
    pub fn capture(stderr: ChildStderr) -> Self {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let output = bytes.clone();
        let reader = std::thread::spawn(move || {
            let mut stream = stderr;
            let mut chunk = [0; 4096];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut buffer = output.lock().unwrap();
                buffer.extend_from_slice(&chunk[..n]);
                let excess = buffer.len().saturating_sub(8192);
                buffer.drain(..excess);
            }
        });
        Self {
            bytes,
            reader: Some(reader),
        }
    }
    pub fn exited(&mut self, status: std::process::ExitStatus) -> String {
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        startup_message(&self.bytes.lock().unwrap()).unwrap_or_else(|| format!("Router exited during startup ({status}). Check the bundled runtime and state folder, then Reload."))
    }
}
fn startup_message(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find_map(|line| {
            let value: serde_json::Value =
                serde_json::from_str(line.strip_prefix("AAR_STARTUP_ERROR:")?).ok()?;
            let message = value["message"].as_str()?;
            (message.len() <= 1024 && !message.chars().any(char::is_control))
                .then(|| message.to_string())
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_details_never_fall_back_to_raw_output() {
        assert!(startup_message(b"private unexpected stderr").is_none());
        assert!(startup_message(b"AAR_STARTUP_ERROR:not-json").is_none());
        assert_eq!(
            startup_message(b"ignored\nAAR_STARTUP_ERROR:{\"message\":\"Address is in use\"}\n"),
            Some("Address is in use".into())
        );
    }
    #[test]
    fn startup_pipe_is_drained_and_bounded() {
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "head -c 65536 /dev/zero >&2; printf '\\nAAR_STARTUP_ERROR:{\"message\":\"Safe detail\"}\\n' >&2"]).stderr(std::process::Stdio::piped()).spawn().unwrap();
        let mut diagnostic = Diagnostics::capture(child.stderr.take().unwrap());
        let status = child.wait().unwrap();
        assert_eq!(diagnostic.exited(status), "Safe detail");
        assert!(diagnostic.bytes.lock().unwrap().len() <= 8192);
    }
}
