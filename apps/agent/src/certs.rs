//! Platform link-TLS PEM material persisted to `certs/` in the working
//! directory. Content-unchanged skips; any change flips the returned flag so
//! the runtime force-rebuilds TLS services (rustls configs embed the parsed
//! certificates — without the rebuild a rotated PEM would only load after a
//! process restart). GOST parsed cert files at service-parse time; kaminari
//! does the same, hence the identical discipline.

use std::fs;
use std::io;
use std::path::Path;

use crate::model::TlsMaterial;

pub const CERTS_DIR: &str = "certs";

pub struct Certs {
    pub changed: bool,
}

struct NamedPem<'a> {
    file: &'a str,
    content: &'a str,
}

/// Write every PEM (tmp + fsync + rename, 0700 dir / 0600 files). Must run
/// BEFORE the config is applied — services resolve these paths when their
/// TLS acceptor is built.
pub fn ensure(material: &TlsMaterial) -> io::Result<Certs> {
    ensure_in(std::path::Path::new("."), material)
}

/// Path-injected variant (tests run in parallel temp dirs — the process CWD
/// is global and must not be raced).
pub fn ensure_in(base: &Path, material: &TlsMaterial) -> io::Result<Certs> {
    let dir = base.join(CERTS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
    }

    let pems = [
        NamedPem { file: "ca.pem", content: &material.ca_cert },
        NamedPem { file: "server.pem", content: &material.server_cert },
        NamedPem { file: "server_key.pem", content: &material.server_key },
        NamedPem { file: "client.pem", content: &material.client_cert },
        NamedPem { file: "client_key.pem", content: &material.client_key },
    ];

    let mut changed = false;
    for pem in &pems {
        let path = dir.join(pem.file);
        if let Ok(existing) = fs::read_to_string(&path) {
            if existing == pem.content {
                continue; // unchanged — skip the write AND the rebuild trigger
            }
        }
        write_private(&path, pem.content.as_bytes())?;
        changed = true;
    }
    Ok(Certs { changed })
}

/// Path helpers for the kaminari conf strings.
pub fn server_cert_path() -> String {
    Path::new(CERTS_DIR).join("server.pem").to_string_lossy().into_owned()
}

pub fn server_key_path() -> String {
    Path::new(CERTS_DIR).join("server_key.pem").to_string_lossy().into_owned()
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let tmp = path.with_extension("pem.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material(seed: &str) -> TlsMaterial {
        TlsMaterial {
            sni: "relay.example.test".into(),
            ca_cert: format!("---CA {seed}---"),
            server_cert: format!("---SC {seed}---"),
            server_key: format!("---SK {seed}---"),
            client_cert: format!("---CC {seed}---"),
            client_key: format!("---CK {seed}---"),
        }
    }

    #[test]
    fn writes_once_then_skips_unchanged() {
        let dir = std::env::temp_dir().join(format!("tyz-agent-certs-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let first = super::ensure_in(&dir, &material("a")).unwrap();
        assert!(first.changed);
        let second = super::ensure_in(&dir, &material("a")).unwrap();
        assert!(!second.changed, "identical content must not flag a rebuild");
        let third = super::ensure_in(&dir, &material("b")).unwrap();
        assert!(third.changed);

        assert!(dir.join(CERTS_DIR).join("server.pem").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
