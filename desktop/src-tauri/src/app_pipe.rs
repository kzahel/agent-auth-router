//! Desktop pipe to the core's private app socket: newline-delimited JSON.
//! Rust authenticates with the owner credential and then relays messages
//! unchanged; the webview never sees the credential, and the core decides
//! which operations the desktop may call.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_LINE: usize = 16 * 1024 * 1024;

fn unavailable(error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::NotFound => "Router unavailable (ENOENT)".into(),
        ErrorKind::ConnectionRefused => "Router unavailable (ECONNREFUSED)".into(),
        _ => "Router unavailable".into(),
    }
}

/// Reads the private owner credential, refusing links and shared files.
fn owner_token(state: &Path) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let path = state.join("owner.key");
    let metadata = std::fs::symlink_metadata(&path).map_err(unavailable)?;
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err("Insecure owner credential".into());
    }
    let token = std::fs::read_to_string(&path).map_err(|_| "Cannot read owner credential")?;
    if !token.starts_with("aar_owner_") || token.len() != 53 {
        return Err("Invalid owner credential".into());
    }
    Ok(token)
}

fn read_message(reader: &mut BufReader<UnixStream>) -> Result<Value, String> {
    let mut line = String::new();
    let read = reader
        .by_ref()
        .take(MAX_LINE as u64)
        .read_line(&mut line)
        .map_err(|_| "Router connection failed")?;
    if read == 0 {
        return Err("Router connection closed".into());
    }
    serde_json::from_str(&line).map_err(|_| "Invalid router message".into())
}

/// Opens an authenticated connection; returns the writer, reader and hello.
pub fn connect(state: &Path) -> Result<(UnixStream, BufReader<UnixStream>, Value), String> {
    let stream = UnixStream::connect(state.join("app.sock")).map_err(unavailable)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Router connection failed")?;
    let mut writer = stream.try_clone().map_err(|_| "Router connection failed")?;
    let token = owner_token(state)?;
    writeln!(writer, "{}", json!({ "hello": { "token": token } }))
        .map_err(|_| "Router connection failed")?;
    let mut reader = BufReader::new(stream);
    let hello = read_message(&mut reader)?;
    match hello.get("hello") {
        Some(value) => Ok((writer, reader, value.clone())),
        None => Err(hello["error"]["message"]
            .as_str()
            .unwrap_or("Router refused the desktop connection")
            .into()),
    }
}

/// One request over a short-lived connection, for lifecycle work in Rust.
pub fn call(state: &Path, operation: &str, body: Value) -> Result<Value, String> {
    let (mut writer, mut reader, _) = connect(state)?;
    reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|_| "Router connection failed")?;
    writeln!(
        writer,
        "{}",
        json!({ "id": 1, "call": operation, "body": body })
    )
    .map_err(|_| "Router request failed")?;
    loop {
        let message = read_message(&mut reader)?;
        if message["id"] != 1 {
            continue; // Change events may arrive before the reply.
        }
        if let Some(result) = message.get("result") {
            return Ok(result.clone());
        }
        return Err(message["error"]["message"]
            .as_str()
            .unwrap_or("Router request failed")
            .into());
    }
}

/// The webview's persistent connection. Replacing it closes the old one;
/// only the current connection reports closure.
#[derive(Default)]
pub struct Pipe(Arc<Mutex<Option<(u64, UnixStream)>>>);

impl Pipe {
    pub fn open(
        &self,
        state: &Path,
        mut emit: impl FnMut(Option<Value>) + Send + 'static,
    ) -> Result<Value, String> {
        let (writer, mut reader, hello) = connect(state)?;
        reader
            .get_ref()
            .set_read_timeout(None)
            .map_err(|_| "Router connection failed")?;
        let mut current = self.0.lock().map_err(|_| "Router connection unavailable")?;
        if let Some((_, old)) = current.take() {
            let _ = old.shutdown(std::net::Shutdown::Both);
        }
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let generation = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *current = Some((generation, writer));
        drop(current);
        let slot = Arc::clone(&self.0);
        std::thread::spawn(move || {
            while let Ok(message) = read_message(&mut reader) {
                emit(Some(message));
            }
            let mut current = match slot.lock() {
                Ok(current) => current,
                Err(_) => return,
            };
            if current.as_ref().is_some_and(|(g, _)| *g == generation) {
                *current = None;
                drop(current);
                emit(None);
            }
        });
        Ok(hello)
    }
    pub fn send(&self, message: &Value) -> Result<(), String> {
        if message.get("hello").is_some() {
            return Err("The desktop shell authenticates the connection".into());
        }
        let mut current = self.0.lock().map_err(|_| "Router connection unavailable")?;
        let (_, writer) = current.as_mut().ok_or("Router connection closed")?;
        writeln!(writer, "{message}").map_err(|_| "Router connection closed".to_string())
    }
    pub fn close(&self) {
        if let Ok(mut current) = self.0.lock() {
            if let Some((_, stream)) = current.take() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    fn state() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aar-pipe-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("owner.key");
        std::fs::write(&key, format!("aar_owner_{}", "a".repeat(43))).unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        dir
    }

    #[test]
    fn calls_authenticate_first_and_skip_events_until_the_reply() {
        let dir = state();
        let listener = UnixListener::bind(dir.join("app.sock")).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            let hello = read_message(&mut reader).unwrap();
            assert_eq!(
                hello["hello"]["token"],
                format!("aar_owner_{}", "a".repeat(43))
            );
            writeln!(writer, r#"{{"hello":{{"protocol":1}}}}"#).unwrap();
            let call = read_message(&mut reader).unwrap();
            assert_eq!(call["call"], "overview");
            writeln!(writer, r#"{{"event":"change","data":{{"revision":1}}}}"#).unwrap();
            writeln!(writer, r#"{{"id":1,"result":{{"routerId":"r"}}}}"#).unwrap();
        });
        let result = call(&dir, "overview", json!({})).unwrap();
        assert_eq!(result["routerId"], "r");
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_or_shared_credentials_and_sockets_are_reported() {
        let dir = state();
        assert!(call(&dir, "overview", json!({}))
            .unwrap_err()
            .contains("ENOENT"));
        let _listener = UnixListener::bind(dir.join("app.sock")).unwrap();
        std::fs::set_permissions(
            dir.join("owner.key"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(
            connect(&dir).unwrap_err(),
            "Insecure owner credential".to_string()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn webview_messages_cannot_replace_the_handshake() {
        let pipe = Pipe::default();
        assert!(pipe
            .send(&json!({"hello": {"token": "x"}}))
            .unwrap_err()
            .contains("authenticates"));
        assert_eq!(
            pipe.send(&json!({"id": 1, "call": "overview"}))
                .unwrap_err(),
            "Router connection closed"
        );
    }
}
