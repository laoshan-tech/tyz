//! Offline bootstrap cache: the last successfully applied config response,
//! persisted atomically and replayed at startup so an unchanged config after
//! a control-plane outage costs one 304. Unreadable/stale caches are skipped
//! with a warning (a legacy Go-era cache is exactly that).

use std::io;
use std::path::{Path, PathBuf};

use crate::model::AgentConfigResponse;

pub const CACHE_FILE: &str = "last-config.json";

fn cache_path() -> PathBuf {
    PathBuf::from(CACHE_FILE)
}

/// Path-injected variants (tests run in parallel temp dirs).
pub fn save_at(path: &Path, resp: &AgentConfigResponse) {
    if let Err(err) = atomic_write(path, &serde_json::to_vec_pretty(resp).expect("serialize"), 0o600) {
        panic!("test helper write failed: {err}");
    }
}

pub fn load_at(path: &Path) -> Option<AgentConfigResponse> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Write via tmp + fsync + rename: power loss must never leave a truncated
/// cache (the same discipline as the Go agent).
fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let mut f = std::fs::File::create(&tmp)?;
        f.set_permissions(std::fs::Permissions::from_mode(mode))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Persist a config response (0600 — tls_material PEMs ride inside).
pub fn save(resp: &AgentConfigResponse) {
    let bytes = match serde_json::to_vec_pretty(resp) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!("cache serialize failed: {err}");
            return;
        }
    };
    if let Err(err) = atomic_write(&cache_path(), &bytes, 0o600) {
        tracing::warn!("cache write failed: {err}");
    }
}

/// Load the cached response. Any error → None + warning (start from scratch).
pub fn load() -> Option<AgentConfigResponse> {
    let bytes = match std::fs::read(cache_path()) {
        Ok(b) => b,
        Err(err) => {
            tracing::info!("no offline cache ({err}); starting with a full refresh");
            None?
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(resp) => Some(resp),
        Err(err) => {
            tracing::warn!("offline cache unreadable ({err}); skipping replay");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NodeInfo, RealmNodeConfig};

    fn resp(version: i64) -> AgentConfigResponse {
        AgentConfigResponse {
            version,
            config: RealmNodeConfig {
                agent: "realm".into(),
                node: NodeInfo { id: 7, name: "n7".into() },
                services: vec![],
                tls_material: None,
            },
        }
    }

    #[test]
    fn roundtrip_in_tempdir() {
        let dir = std::env::temp_dir().join(format!("tyz-agent-store-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = dir.join(CACHE_FILE);
        save_at(&cache, &resp(42));
        let loaded = load_at(&cache).unwrap();
        assert_eq!(loaded.version, 42);
        assert_eq!(loaded.config.node.id, 7);
        // round-trip through the CWD-relative API as well
        assert!(serde_json::from_slice::<AgentConfigResponse>(&std::fs::read(&cache).unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
