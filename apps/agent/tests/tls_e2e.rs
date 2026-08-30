//! TLS link end-to-end: kaminari exit (server cert from certs/) ⇄ kaminari
//! entry (insecure client, platform SNI). Own test FILE = own process, so the
// process-wide chdir into the certs tempdir is race-free.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use tyz_agent::model::{NodeInfo, RealmNodeConfig, RealmService, TlsMaterial, TlsSide};
use tyz_agent::runtime::{SharedSupervisor, Supervisor};

const SNI: &str = "relay.example.test";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn material(cert_pem: String, key_pem: String) -> TlsMaterial {
    TlsMaterial {
        sni: SNI.into(),
        ca_cert: cert_pem.clone(),
        server_cert: cert_pem.clone(),
        server_key: key_pem.clone(),
        client_cert: cert_pem,
        client_key: key_pem,
    }
}

fn service(name: &str, listen: u16, host: &str, port: u16, tls: Option<TlsSide>) -> RealmService {
    RealmService {
        name: name.into(),
        listen_host: "127.0.0.1".into(),
        listen_port: listen,
        target_host: host.into(),
        target_port: port,
        extra_targets: vec![],
        balance: None,
        tls_side: tls,
        alpn: vec![],
        connect_timeout_s: Some(3),
    }
}

async fn spawn_echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn tls_link_entry_to_exit() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            tracing_subscriber::EnvFilter::new("warn")
        }))
        .try_init();
    kaminari::install_tls_provider();

    // Self-signed platform cert (the server does not verify clients; the
    // client runs insecure — the accepted decision set).
    let ck = rcgen::generate_simple_self_signed(vec![SNI.into()]).unwrap();
    let cert_pem = ck.cert.pem();
    let key_pem = ck.signing_key.serialize_pem();

    // certs/ must land in a private tempdir; the acceptor resolves
    // certs/server.pem relative to the CWD.
    let dir = std::env::temp_dir().join(format!("tyz-agent-tls-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let prev = std::env::current_dir().unwrap();
    std::env::set_current_dir(&dir).unwrap();

    let changed = tyz_agent::certs::ensure(&material(cert_pem.clone(), key_pem.clone()))
        .unwrap()
        .changed;
    assert!(changed);

    let target_port = spawn_echo().await;
    let entry_port = free_port();
    let exit_port = free_port();

    let apply = |services: Vec<RealmService>, tls: Option<TlsMaterial>| async move {
        let stats = tyz_agent::stats::StatsRegistry::new();
        let supervisor: SharedSupervisor = Arc::new(AsyncMutex::new(Supervisor::new(stats.clone())));
        let config = RealmNodeConfig {
            agent: "realm".into(),
            node: NodeInfo { id: 1, name: "n".into() },
            services,
            tls_material: tls,
        };
        let outcome = supervisor.lock().await.apply_config(&config, false).await.expect("translate");
        assert!(outcome.ok(), "apply failures: {:?}", outcome.failures);
        supervisor
    };

    let exit = apply(
        vec![service("service-1", exit_port, "127.0.0.1", target_port, Some(TlsSide::Listen))],
        Some(material(cert_pem.clone(), key_pem.clone())),
    )
    .await;
    let entry = apply(
        vec![service("service-1", entry_port, "127.0.0.1", exit_port, Some(TlsSide::Connect))],
        Some(material(cert_pem.clone(), key_pem.clone())),
    )
    .await;
    let _ = exit; // keeps the exit supervisor's services alive
    let _ = entry;

    // Forward through the TLS link: client → entry(plain) ⇒ TLS ⇒ exit → echo.
    const PAYLOAD: &[u8] = b"tyz-tls-e2e-probe-payload";
    let mut sock = tokio::time::timeout(std::time::Duration::from_secs(5), TcpStream::connect(("127.0.0.1", entry_port)))
        .await
        .expect("connect within timeout")
        .expect("connect ok");
    sock.write_all(PAYLOAD).await.unwrap();
    let mut back = vec![0u8; PAYLOAD.len()];
    tokio::time::timeout(std::time::Duration::from_secs(5), sock.read_exact(&mut back))
        .await
        .expect("tls echo within timeout")
        .expect("echo read ok");
    assert_eq!(back, PAYLOAD, "traffic must traverse the kaminari TLS link");

    // A plaintext probe straight at the TLS exit must NOT be echoed: the
    // handshake fails and the connection dies. The probe may see a short TLS
    // ALERT record (what any real TLS server answers to garbage) — the
    // invariant is: never the request echoed back, and the link settles fast.
    let mut probe = TcpStream::connect(("127.0.0.1", exit_port)).await.expect("probe connect");
    probe.write_all(b"GET /probe HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let mut buf = vec![0u8; 64];
    let seen = tokio::time::timeout(std::time::Duration::from_secs(3), probe.read(&mut buf))
        .await
        .expect("probe must settle (timeout would mean a hung handshake)")
        .unwrap_or(0);
    assert!(seen <= 8, "no raw echo through the TLS exit (got {seen} bytes: {:?})", &buf[..seen]);
    assert!(!buf[..seen].windows(4).any(|w| w == b"robe"), "the plaintext request must never come back");

    std::env::set_current_dir(prev).unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
