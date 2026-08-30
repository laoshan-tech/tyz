//! WebSocket push channel — the state machine mirrors the Go agent's
//! (cp/ws.go) parameter-for-parameter:
//!
//! - keepalive is a TEXT message `"ping"` — the Durable Object auto-responds
//!   `"pong"` at the edge via setWebSocketAutoResponse, matching text only;
//! - healthy WS ⇒ HTTP polling is a 5-minute safety net (the loop reads
//!   `mode()` to pick its cadence);
//! - every successful (re)connect emits `Connected` → the loop immediately
//!   polls once (a broadcast during a disconnect window is lost otherwise);
//! - ≥3 failures within a 60s sliding window demote to poll mode; while
//!   demoted a probe runs every probe_interval (fixed, no backoff), and a
//!   successful probe promotes back to ws mode;
//! - reconnect backoff in ws mode: 1s doubling to 60s max.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::model::PushMessage;

const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const FAILURE_THRESHOLD: usize = 3;
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Ws,
    Poll,
}

#[derive(Debug)]
pub enum WsEvent {
    /// A (re)connect succeeded — poll immediately.
    Connected,
    ConfigChanged,
    RestartService(String),
    /// Mode flipped; the loop adjusts its poll cadence.
    ModeChanged(Mode),
}

pub struct WsOpts {
    pub url: String,
    pub token: String,
    pub ping_interval: Duration,
    pub probe_interval: Duration,
}

pub struct WsChannel {
    /// Shared cadence flag: true = ws (loop uses the 5-min safety net).
    ws_mode: std::sync::Arc<AtomicBool>,
    #[cfg_attr(not(test), allow(dead_code))] // stop() exercised by tests
    task: tokio::task::JoinHandle<()>,
}

impl WsChannel {
    pub fn spawn(opts: WsOpts, events: mpsc::Sender<WsEvent>) -> Self {
        let ws_mode = std::sync::Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(run(opts, events, ws_mode.clone()));
        Self { ws_mode, task }
    }

    /// A channel that never connects and permanently reports Poll mode —
    /// used when WS_ENABLED=false (pure HTTP polling cadence).
    pub fn stub() -> Self {
        let ws_mode = std::sync::Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(std::future::pending::<()>());
        Self { ws_mode, task }
    }

    pub fn mode(&self) -> Mode {
        if self.ws_mode.load(Ordering::Relaxed) {
            Mode::Ws
        } else {
            Mode::Poll
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

async fn run(opts: WsOpts, events: mpsc::Sender<WsEvent>, ws_mode: std::sync::Arc<AtomicBool>) {
    let mut failures: Vec<Instant> = Vec::new();
    let mut backoff = BACKOFF_MIN;

    loop {
        match connect_and_session(&opts, &events, &mut failures, &ws_mode).await {
            ConnectResult::BadUrl => {
                record_failure(&mut failures);
                tokio::time::sleep(BACKOFF_MIN).await;
                continue;
            }
            ConnectResult::Refused => {
                record_failure(&mut failures);
            }
            ConnectResult::Session(outcome) => {
                // Any session end (clean close included) counts as a failure —
                // flapping links demote exactly like refused connects.
                record_failure(&mut failures);
                if matches!(outcome, SessionOutcome::Failed) {
                    tracing::debug!("ws session ended with failure");
                }
            }
        }

        let demoted = failures.len() >= FAILURE_THRESHOLD;
        let new_mode = if demoted { Mode::Poll } else { Mode::Ws };
        let flipped = ws_mode.swap(matches!(new_mode, Mode::Ws), Ordering::Relaxed) != matches!(new_mode, Mode::Ws);
        if flipped {
            tracing::warn!(
                reason = if demoted { "flapping" } else { "recovered" },
                "config push channel mode change: {:?}", new_mode
            );
            let _ = events.send(WsEvent::ModeChanged(new_mode)).await;
        }

        // Next attempt: probe interval while demoted (fixed), backoff in ws mode.
        if matches!(new_mode, Mode::Poll) {
            tokio::time::sleep(opts.probe_interval).await;
        } else {
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }
}

fn record_failure(failures: &mut Vec<Instant>) {
    let now = Instant::now();
    failures.push(now);
    failures.retain(|t| now.duration_since(*t) <= FAILURE_WINDOW);
}

enum SessionOutcome {
    /// Peer sent a close frame / stream ended.
    Closed,
    /// Transport error, handshake failure, or idle watchdog trip.
    Failed,
}

enum ConnectResult {
    BadUrl,
    Refused,
    Session(SessionOutcome),
}

async fn connect_and_session(
    opts: &WsOpts,
    events: &mpsc::Sender<WsEvent>,
    failures: &mut Vec<Instant>,
    ws_mode: &std::sync::Arc<AtomicBool>,
) -> ConnectResult {
    let mut request = match opts.url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => return ConnectResult::BadUrl,
    };
    use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {}", opts.token).parse().expect("header value"),
    );

    let (ws, _resp) = match tokio_tungstenite::connect_async(request).await {
        Ok(x) => x,
        Err(err) => {
            tracing::debug!("ws connect failed: {err}");
            return ConnectResult::Refused;
        }
    };

    // A successful handshake is promotion evidence AND clears the failure
    // window (the Go agent's `c.failures = nil`) — without the reset a
    // demoted channel could never recover while its stale failures age out.
    failures.clear();

    // Promote immediately: a healthy connection is live evidence — waiting
    // for the session to END would keep a working link stuck in poll mode.
    update_mode(ws_mode, failures, events).await;

    // A (re)connect always triggers an immediate poll: broadcasts fired
    // while disconnected are lost (the DO pushes to live sockets only).
    let _ = events.send(WsEvent::Connected).await;

    ConnectResult::Session(session(ws, opts, events).await)
}

/// Recompute ws/poll mode from the failure window and announce flips.
async fn update_mode(
    ws_mode: &std::sync::Arc<AtomicBool>,
    failures: &[Instant],
    events: &mpsc::Sender<WsEvent>,
) {
    let demoted = failures.len() >= FAILURE_THRESHOLD;
    let new_mode = if demoted { Mode::Poll } else { Mode::Ws };
    let flipped = ws_mode.swap(matches!(new_mode, Mode::Ws), Ordering::Relaxed) != matches!(new_mode, Mode::Ws);
    if flipped {
        tracing::warn!(
            reason = if demoted { "flapping" } else { "recovered" },
            "config push channel mode change: {:?}",
            new_mode
        );
        let _ = events.send(WsEvent::ModeChanged(new_mode)).await;
    }
}

async fn session(
    mut ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    opts: &WsOpts,
    events: &mpsc::Sender<WsEvent>,
) -> SessionOutcome {
    // Read watchdog: the DO answers "ping" with "pong"; ANY inbound frame
    // proves liveness. Silence beyond 2× the ping interval = dead link (the
    // Cloudflare edge drops idle sockets at ~100s). The sleep is created
    // fresh inside the select each iteration — every received frame resets it.
    let watchdog = opts.ping_interval.saturating_mul(2);
    let mut ping_tick = tokio::time::interval(opts.ping_interval);
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping_tick.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            _ = tokio::time::sleep(watchdog) => {
                return SessionOutcome::Failed;
            }
            _ = ping_tick.tick() => {
                if ws.send(Message::Text("ping".into())).await.is_err() {
                    return SessionOutcome::Failed;
                }
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if text == "pong" {
                            continue; // keepalive echo, reset via loop
                        }
                        if let Ok(push) = serde_json::from_str::<PushMessage>(&text) {
                            let evt = match push.kind.as_str() {
                                "config_changed" => Some(WsEvent::ConfigChanged),
                                "restart_service" => push
                                    .service
                                    .as_deref()
                                    .map(|s| WsEvent::RestartService(s.to_string())),
                                other => {
                                    tracing::debug!("unknown push message type {other:?}");
                                    None
                                }
                            };
                            if let Some(evt) = evt {
                                if events.send(evt).await.is_err() {
                                    return SessionOutcome::Closed; // consumer gone (shutdown)
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return SessionOutcome::Closed,
                    Some(Ok(_)) => { /* binary/ping frames: liveness only */ }
                    Some(Err(_)) => return SessionOutcome::Failed,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    

    /// Local echo-push WS server: answers "ping"→"pong", greets with a
    /// config_changed, then forwards scripted pushes.
    async fn spawn_ws_server(pushes: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(x) => x,
                    Err(_) => return,
                };
                let pushes = pushes.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    let _ = ws.send(Message::Text(r#"{"type":"config_changed"}"#.into())).await;
                    // scripted pushes go out right after the greeting (the
                    // agent itself only ever sends "ping" texts)
                    loop {
                        let next = pushes.lock().unwrap().pop();
                        match next {
                            Some(p) => {
                                let _ = ws.send(Message::Text(p)).await;
                            }
                            None => break,
                        }
                    }
                    while let Some(Ok(msg)) = ws.next().await {
                        if let Message::Text(text) = msg {
                            if text == "ping" {
                                let _ = ws.send(Message::Text("pong".into())).await;
                            }
                        }
                    }
                });
            }
        });
        format!("ws://{addr}/api/agent/ws")
    }

    #[tokio::test]
    async fn delivers_pushes_and_recovers_mode() {
        let pushes: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::new(
            std::sync::Mutex::new(vec![r#"{"type":"restart_service","service":"service-9"}"#.to_string()]),
        );
        let url = spawn_ws_server(pushes).await;
        let (tx, mut rx) = mpsc::channel(64);
        let channel = WsChannel::spawn(
            WsOpts {
                url,
                token: "t".into(),
                ping_interval: Duration::from_millis(50),
                probe_interval: Duration::from_millis(50),
            },
            tx,
        );

        let mut saw_connected = false;
        let mut saw_changed = false;
        let mut saw_restart = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && (!saw_connected || !saw_changed || !saw_restart) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let msg = tokio::time::timeout(remaining, rx.recv()).await;
            let msg = match msg {
                Ok(msg) => msg,
                Err(_) => break, // deadline elapsed
            };
            match msg {
                Some(WsEvent::Connected) => saw_connected = true,
                Some(WsEvent::ConfigChanged) => saw_changed = true,
                Some(WsEvent::RestartService(s)) => {
                    assert_eq!(s, "service-9");
                    saw_restart = true;
                }
                Some(WsEvent::ModeChanged(_)) => {}
                None => break,
            }
        }
        assert!(saw_connected && saw_changed && saw_restart);
        assert_eq!(channel.mode(), Mode::Ws, "a healthy link must stay in ws mode");
        channel.stop().await;
    }

    #[tokio::test]
    async fn dead_server_demotes_then_probes_back() {
        // Bind then immediately drop the listener: connects fail fast.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("ws://{addr}/x");

        let (tx, mut rx) = mpsc::channel(64);
        let channel = WsChannel::spawn(
            WsOpts {
                url,
                token: "t".into(),
                ping_interval: Duration::from_millis(50),
                probe_interval: Duration::from_millis(80),
            },
            tx,
        );

        // 3 failures within the window → demotion event.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut demoted = false;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(WsEvent::ModeChanged(mode))) => {
                    assert_eq!(mode, Mode::Poll);
                    demoted = true;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        assert!(demoted);
        assert_eq!(channel.mode(), Mode::Poll);

        // Bring a server up on the same port: the fixed-interval probe must
        // promote the channel back to ws mode and fire an immediate poll.
        let pushes: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let reuse = TcpListener::bind(addr).await.unwrap();
        let pushes2: std::sync::Arc<std::sync::Mutex<Vec<String>>> = pushes.clone();
        let _ = &pushes2;
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = reuse.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    let _ = ws.send(Message::Text(r#"{"type":"config_changed"}"#.into())).await;
                    while let Some(Ok(msg)) = ws.next().await {
                        if let Message::Text(t) = msg {
                            if t == "ping" {
                                let _ = ws.send(Message::Text("pong".into())).await;
                            }
                        }
                    }
                });
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut promoted = false;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(WsEvent::ModeChanged(mode))) => {
                    assert_eq!(mode, Mode::Ws);
                    promoted = true;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        assert!(promoted, "probe must promote the channel back to ws mode");
        channel.stop().await;
    }
}
