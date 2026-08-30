//! End-to-end against a mock control plane: config fetch → apply → real
//! forwarding through TWO supervisors (entry + exit, raw port-pair shape) →
//! stats flush arrives at the server → 304 fast path → restart directive →
//! target hot-swap. The full chain minus the WS channel (covered by unit
//! tests) and the process shell (main.rs).

use std::sync::{Arc, Mutex};

use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use tyz_agent::control::Flush;
use tyz_agent::cp::http::{CpClient, Fetched};
use tyz_agent::model::{NodeInfo, RealmNodeConfig, RealmService};
use tyz_agent::runtime::{SharedSupervisor, Supervisor};

const ENTRY_TOKEN: &str = "entry-token";
const EXIT_TOKEN: &str = "exit-token";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn service(name: &str, listen: u16, host: &str, port: u16) -> RealmService {
    RealmService {
        name: name.into(),
        listen_host: "127.0.0.1".into(),
        listen_port: listen,
        target_host: host.into(),
        target_port: port,
        extra_targets: vec![],
        balance: None,
        tls_side: None,
        alpn: vec![],
        connect_timeout_s: Some(2),
    }
}

fn config(node_id: i64, services: Vec<RealmService>) -> RealmNodeConfig {
    RealmNodeConfig {
        agent: "realm".into(),
        node: NodeInfo { id: node_id, name: format!("node-{node_id}") },
        services,
        tls_material: None,
    }
}

/// Plain byte-echo target (answers once per connection, then half-closes).
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

#[derive(Default)]
struct CpState {
    entry_config: Mutex<Vec<RealmService>>, // mutable: the hot-swap test rewrites it
    exit_config: Mutex<Vec<RealmService>>,
    version: Mutex<i64>,
    uploads: Mutex<Vec<serde_json::Value>>,
}

/// Mock control plane: token-routed config endpoint + stats recorder.
async fn spawn_cp(state: Arc<CpState>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let state = state.clone();
                    async move { handle(req, state).await }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });
    format!("http://{addr}")
}

async fn handle(req: Request<Incoming>, state: Arc<CpState>) -> Result<Response<Full<tokio_util::bytes::Bytes>>, std::convert::Infallible> {
    let token = req
        .headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let path = req.uri().path();

    if req.method() == "GET" && path == "/api/agent/config" {
        let current = *state.version.lock().unwrap();
        let asked: i64 = req
            .uri()
            .query()
            .and_then(|q| q.split('=').nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if asked >= current {
            return Ok(Response::builder().status(StatusCode::NOT_MODIFIED).body(Full::default()).unwrap());
        }
        let services = match token.as_str() {
            EXIT_TOKEN => state.exit_config.lock().unwrap().clone(),
            _ => state.entry_config.lock().unwrap().clone(),
        };
        let node_id = if token == EXIT_TOKEN { 2 } else { 1 };
        let body = serde_json::json!({ "version": current, "config": config(node_id, services) });
        return Ok(Response::new(Full::new(body.to_string().into())));
    }

    if req.method() == "POST" && path == "/api/agent/stats" {
        let body = req.into_body().collect().await.unwrap().to_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        state.uploads.lock().unwrap().push(parsed);
        return Ok(Response::new(Full::new(r#"{"ok":true}"#.into())));
    }

    Ok(Response::builder().status(StatusCode::NOT_FOUND).body(Full::default()).unwrap())
}

async fn forward_roundtrip(port: u16, payload: &[u8]) -> Vec<u8> {
    let mut sock = tokio::time::timeout(std::time::Duration::from_secs(5), TcpStream::connect(("127.0.0.1", port)))
        .await
        .expect("connect within timeout")
        .expect("connect ok");
    sock.write_all(payload).await.unwrap();
    // brutal-shutdown (realm's default) cuts the relay when the client
    // half-closes — read the response BEFORE closing the write side.
    let mut back = vec![0u8; payload.len()];
    tokio::time::timeout(std::time::Duration::from_secs(5), sock.read_exact(&mut back))
        .await
        .expect("echo within timeout")
        .expect("echo read ok");
    back
}

struct Node {
    supervisor: SharedSupervisor,
    cp: Arc<CpClient>,
    stats: Arc<tyz_agent::stats::StatsRegistry>,
}

async fn drive_apply(node: &Node, expected_services: usize) {
    let fetched = node.cp.fetch_config(0).await.expect("fetch");
    let Fetched::Changed(resp) = fetched else {
        panic!("expected a fresh config");
    };
    let outcome = node
        .supervisor
        .lock()
        .await
        .apply_config(&resp.config, false)
        .await
        .expect("translate");
    assert!(outcome.ok(), "no apply failures: {:?}", outcome.failures);
    assert_eq!(node.supervisor.lock().await.service_count(), expected_services);
}

fn flusher(node: &Node, cp: Arc<CpClient>) -> Flush {
    Flush::new(cp, node.supervisor.clone(), node.stats.clone(), std::time::Duration::from_secs(60))
}

/// Silence tracing in tests unless RUST_LOG is set (keeps failures readable).
fn quiet_logger() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .try_init();
}

#[tokio::test]
async fn two_node_forwarding_config_sync_and_stats() {
    quiet_logger();
    kaminari::install_tls_provider();

    let target_port = spawn_echo().await;
    let entry_port = free_port();
    let exit_port = free_port();

    let state = Arc::new(CpState {
        entry_config: Mutex::new(vec![service("service-1", entry_port, "127.0.0.1", exit_port)]),
        exit_config: Mutex::new(vec![service("service-1", exit_port, "127.0.0.1", target_port)]),
        version: Mutex::new(1),
        uploads: Mutex::new(vec![]),
    });
    let base = spawn_cp(state.clone()).await;

    let make_node = |token: &str| {
        let stats = tyz_agent::stats::StatsRegistry::new();
        let supervisor: SharedSupervisor = Arc::new(AsyncMutex::new(Supervisor::new(stats.clone())));
        let cp = Arc::new(CpClient::new(&base, token));
        Node { supervisor, cp, stats }
    };
    let entry = make_node(ENTRY_TOKEN);
    let exit = make_node(EXIT_TOKEN);

    // 1. config sync: both nodes apply their half of the port pair
    drive_apply(&entry, 1).await;
    drive_apply(&exit, 1).await;

    // 2. real forwarding: client → entry → exit → echo → back
    const PAYLOAD: &[u8] = b"tyz-e2e-forwarding-probe-payload-0123456789";
    let back = forward_roundtrip(entry_port, PAYLOAD).await;
    assert_eq!(back, PAYLOAD);

    // 3. stats flush: both legs report service-1, service-level rows present
    flusher(&entry, entry.cp.clone()).flush().await.expect("entry flush");
    flusher(&exit, exit.cp.clone()).flush().await.expect("exit flush");

    let uploads = state.uploads.lock().unwrap().clone();
    assert!(uploads.len() >= 2, "both nodes flushed: {}", uploads.len());
    // Chunks after the first carry samples only (health rides the first
    // request of each flush) — assert per flush, not per request.
    let mut saw_service_level = 0;
    let mut saw_running_health = 0;
    for upload in &uploads {
        if let Some(samples) = upload["samples"].as_array() {
            if let Some(svc) = samples
                .iter()
                .find(|s| s["service"] == "service-1" && s["client"].as_str().unwrap_or("").is_empty())
            {
                assert!(svc["totalConns"].as_u64().unwrap() >= 1);
                assert!(svc["inputBytes"].as_u64().unwrap() >= PAYLOAD.len() as u64);
                assert!(svc["outputBytes"].as_u64().unwrap() >= PAYLOAD.len() as u64);
                saw_service_level += 1;
            }
        }
        if let Some(health) = upload["health"].as_array() {
            if health.iter().any(|h| h["service"] == "service-1" && h["state"] == "running") {
                saw_running_health += 1;
            }
        }
    }
    assert_eq!(saw_service_level, 2, "entry and exit both report service-1");
    assert_eq!(saw_running_health, 2, "both nodes' health snapshots show service-1 running");

    // 4. 304 fast path once the version is adopted
    for node in [&entry, &exit] {
        let fetched = node.cp.fetch_config(1).await.expect("fetch");
        assert!(matches!(fetched, Fetched::NotModified));
    }

    // 5. manual restart directive: connections drop, service rebuilds
    entry.supervisor.lock().await.restart("service-1").await;
    let back = forward_roundtrip(entry_port, PAYLOAD).await;
    assert_eq!(back, PAYLOAD, "service must serve again after restart");

    // 6. target hot-swap: new config version points the EXIT at a new echo
    let target2 = spawn_echo().await;
    *state.exit_config.lock().unwrap() = vec![service("service-1", exit_port, "127.0.0.1", target2)];
    *state.version.lock().unwrap() = 2;
    drive_apply(&exit, 1).await;
    let back = forward_roundtrip(entry_port, PAYLOAD).await;
    assert_eq!(back, PAYLOAD, "forwarding continues against the new target");
}
