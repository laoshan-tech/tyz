//! One managed service = one listener + one accept-loop task + a registry of
//! live connection tasks. Unlike realm_core's `run_tcp` (the black box we
//! replaced): bind failure returns an error instead of panicking, the loop
//! stops on cancellation, and connections can be force-dropped (manual
//! restart, TLS material rotation).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kaminari::mix::MixAccept;
use tokio::net::TcpListener;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::model::{TlsMaterial, TlsSide};
use crate::runtime::net::{tls_accept, ClientConn, ConnContext, handle_conn};
use crate::runtime::tlsconf;
use crate::stats::StatsRegistry;
use crate::translate::DesiredService;

/// Track per-service fatal errors for the health snapshot (running/failed).
#[derive(Debug, Default)]
pub struct ServiceHealth {
    error: Mutex<Option<String>>,
}

impl ServiceHealth {
    pub fn state(&self) -> (&'static str, Option<String>) {
        let err = self.error.lock().unwrap();
        match err.as_deref() {
            Some(e) => ("failed", Some(e.to_string())),
            None => ("running", None),
        }
    }

    fn set_error(&self, msg: String) {
        *self.error.lock().unwrap() = Some(msg);
    }
}

#[derive(Default)]
pub struct ConnRegistry {
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, AbortHandle>>,
}

impl ConnRegistry {
    fn insert(&self, handle: AbortHandle) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().unwrap().insert(id, handle);
        id
    }

    fn remove(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
    }

    pub fn abort_all(&self) -> usize {
        let conns: Vec<AbortHandle> = self.conns.lock().unwrap().drain().map(|(_, h)| h).collect();
        let n = conns.len();
        for h in conns {
            h.abort();
        }
        n
    }
}

pub struct ServiceHandle {
    pub desired: Arc<DesiredService>,
    pub listener_addr: std::net::SocketAddr,
    pub health: Arc<ServiceHealth>,
    pub conns: Arc<ConnRegistry>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ServiceHandle {
    /// bind + spawn the accept loop. A bind/constructor failure is returned
    /// (→ apply_failed) — never a panic. The bind itself is synchronous
    /// (std + from_std): port-conflict errors surface here, not inside the
    /// async task where they'd be uncatchable.
    pub fn spawn(
        desired: DesiredService,
        material: Option<&TlsMaterial>,
        stats: Arc<StatsRegistry>,
    ) -> std::io::Result<Self> {
        let std_listener = std::net::TcpListener::bind(desired.listen)?;
        std_listener.set_nonblocking(true)?;
        let listener = TcpListener::from_std(std_listener)?;
        let addr = listener.local_addr()?;
        let desired = Arc::new(desired);

        // TLS assembly happens at construction (handshake-time material):
        // exits serve the platform cert, entries get a client connector.
        let acceptor: Option<MixAccept> = match desired.tls {
            Some(TlsSide::Listen) => Some(tlsconf::server_acceptor().map_err(std::io::Error::other)?),
            _ => None,
        };
        let connector = match desired.tls {
            Some(TlsSide::Connect) => {
                let m = material.ok_or_else(|| std::io::Error::other("tls connect leg without material"))?;
                Some(Arc::new(tlsconf::client_connector(m, &desired.raw.alpn)))
            }
            _ => None,
        };

        let cancel = CancellationToken::new();
        let health = Arc::new(ServiceHealth::default());
        let conns = Arc::new(ConnRegistry::default());
        let task = tokio::spawn(accept_loop(AcceptLoop {
            listener,
            desired: desired.clone(),
            acceptor,
            connector,
            stats,
            health: health.clone(),
            conns: conns.clone(),
            cancel: cancel.clone(),
        }));

        tracing::info!(service = desired.raw.name, listen = %addr, "service listening");
        Ok(Self {
            desired,
            listener_addr: addr,
            health,
            conns,
            cancel,
            task,
        })
    }

    /// True when the accept loop has exited on its own (fatal accept error):
    /// the listener socket is already closed and no new connections are
    /// served, while established connection tasks keep running. Drives the
    /// supervisor's dead-listener self-heal. A handle reached through
    /// `Supervisor.running` is never one that `stop()` finished — stop is only
    /// called on removal from that map.
    pub fn is_dead(&self) -> bool {
        self.task.is_finished()
    }

    /// Test seam: kill the accept loop exactly the way a fatal accept error
    /// does (task exits, listener socket closes, established connections
    /// survive).
    #[cfg(test)]
    pub fn kill_accept_loop_for_test(&mut self) {
        self.task.abort();
    }

    /// Stop the accept loop. `drop_conns`: also abort live connections
    /// (manual restart / TLS rotation); otherwise they run to natural close.
    pub async fn stop(self, drop_conns: bool) {
        self.cancel.cancel();
        if drop_conns {
            let n = self.conns.abort_all();
            if n > 0 {
                tracing::info!(service = self.desired.raw.name, dropped = n, "forced connection drop");
            }
        }
        let _ = self.task.await;
    }

    /// Manual restart directive: close the listener, drop live connections,
    /// rebuild from the last desired config (no re-fetch).
    pub async fn restart(self, material: Option<&TlsMaterial>, stats: Arc<StatsRegistry>) -> std::io::Result<ServiceHandle> {
        let desired = (*self.desired).clone();
        self.stop(true).await;
        ServiceHandle::spawn(desired, material, stats)
    }
}

struct AcceptLoop {
    listener: TcpListener,
    desired: Arc<DesiredService>,
    acceptor: Option<MixAccept>,
    connector: Option<Arc<kaminari::mix::MixConnect>>,
    stats: Arc<StatsRegistry>,
    health: Arc<ServiceHealth>,
    conns: Arc<ConnRegistry>,
    cancel: CancellationToken,
}

async fn accept_loop(al: AcceptLoop) {
    let AcceptLoop {
        listener,
        desired,
        acceptor,
        connector,
        stats,
        health,
        conns,
        cancel,
    } = al;
    let ctx = Arc::new(ConnContext {
        service: desired.clone(),
        connector,
    });
    let name = desired.raw.name.clone();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((sock, peer)) => {
                    let guard = stats.on_conn(&name, &peer.ip().to_string());
                    let ctx = ctx.clone();
                    let acceptor = acceptor.clone();
                    let registry = conns.clone();
                    let svc_name = name.clone();
                    let handle = tokio::spawn(async move {
                        let client = match acceptor {
                            Some(ac) => match tls_accept(sock, &ac).await {
                                Ok(tls) => ClientConn::Tls(Box::new(tls)),
                                Err(err) => {
                                    tracing::debug!(service = svc_name, "tls handshake failed: {err}");
                                    for c in guard.counters() {
                                        c.total_errs.fetch_add(1, Ordering::Relaxed);
                                    }
                                    return;
                                }
                            },
                            None => ClientConn::Plain(sock),
                        };
                        handle_conn(client, peer.ip(), ctx, guard).await;
                    });
                    let id = registry.insert(handle.abort_handle());
                    let registry = conns.clone();
                    tokio::spawn(async move {
                        let _ = handle.await;
                        registry.remove(id);
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::ConnectionAborted => {
                    tracing::warn!(service = name, "accept error: {err}");
                    continue;
                }
                Err(err) => {
                    tracing::error!(service = name, "accept loop fatal: {err}");
                    health.set_error(format!("accept: {err}"));
                    return;
                }
            }
        }
    }
}
