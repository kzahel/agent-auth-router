//! Watch registry file identities, never profile credentials or provider usage.
use std::{path::PathBuf, time::SystemTime};

#[derive(PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
    #[cfg(unix)]
    inode: u64,
}
fn stamps(dir: &std::path::Path) -> Vec<Option<Stamp>> {
    ["control.json", "accounts.json", "clients.json"]
        .iter()
        .map(|name| {
            let metadata = std::fs::symlink_metadata(dir.join(name)).ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(Stamp {
                modified: metadata.modified().ok(),
                len: metadata.len(),
                #[cfg(unix)]
                inode: std::os::unix::fs::MetadataExt::ino(&metadata),
            })
        })
        .collect()
}
pub struct StateWatch {
    dir: PathBuf,
    previous: Vec<Option<Stamp>>,
}
impl StateWatch {
    pub fn new(dir: PathBuf) -> Self {
        let previous = stamps(&dir);
        Self { dir, previous }
    }
    pub fn changed(&mut self) -> bool {
        let next = stamps(&self.dir);
        if next == self.previous {
            return false;
        }
        self.previous = next;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_external_atomic_writes_without_observing_credentials() {
        let dir = std::env::temp_dir().join(format!("aar-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut watch = StateWatch::new(dir.clone());
        assert!(!watch.changed());
        std::fs::write(dir.join("control.json"), "old").unwrap();
        assert!(watch.changed());
        assert!(!watch.changed());
        std::fs::write(dir.join("replacement"), "new").unwrap();
        std::fs::rename(dir.join("replacement"), dir.join("control.json")).unwrap();
        assert!(watch.changed());
        std::fs::write(dir.join("auth.json"), "ignored").unwrap();
        assert!(!watch.changed());
        std::fs::write(dir.join("accounts.json"), "[]").unwrap();
        assert!(watch.changed());
        std::fs::remove_file(dir.join("control.json")).unwrap();
        assert!(watch.changed());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
