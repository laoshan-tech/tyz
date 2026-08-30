//! Supervisor: registry-diff apply over managed services — the moral
//! successor of gostapply, with realm-appropriate connection semantics
//! (config changes keep live connections; only TLS rotation and the manual
//! restart directive drop them). A dead accept loop (fatal accept error)
//! self-heals on the next apply without touching established connections.

pub mod net;
pub mod service;
pub mod tlsconf;
pub mod zero;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::model::{RealmNodeConfig, ServiceHealthSample, TlsMaterial};
use crate::stats::StatsRegistry;
use crate::translate::{translate, DesiredService, TranslateError};

pub use service::ServiceHandle;

#[derive(Debug, Default)]
pub struct ApplyOutcome {
    pub created: usize,
    pub updated: usize,
    pub removed: usize,
    /// (service, error) — each entry surfaces as apply_failed health.
    pub failures: Vec<(String, String)>,
}

impl ApplyOutcome {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

pub struct Supervisor {
    running: HashMap<String, ServiceHandle>,
    /// The last DESIRED set (sorted, failures included) — mirrors gostapply's
    /// `a.last`: retries rebuild only the failed services, and the manual
    /// restart directive rebuilds from here instead of re-fetching.
    last: Vec<DesiredService>,
    /// (name, error) of services that failed the LAST apply (bind/build).
    failures: Vec<(String, String)>,
    material: Option<TlsMaterial>,
    stats: Arc<StatsRegistry>,
}

impl Supervisor {
    pub fn new(stats: Arc<StatsRegistry>) -> Self {
        Self {
            running: HashMap::new(),
            last: Vec::new(),
            failures: Vec::new(),
            material: None,
            stats,
        }
    }

    /// Full pipeline from a fetched payload: flavor guard → translate →
    /// apply. An Err means the version must NOT be adopted (the previous
    /// config keeps serving).
    pub async fn apply_config(
        &mut self,
        config: &RealmNodeConfig,
        tls_material_changed: bool,
    ) -> Result<ApplyOutcome, TranslateError> {
        let desired = translate(config)?;
        // The payload material is authoritative for any TLS assembly.
        self.material = config.tls_material.clone();
        Ok(self.apply(desired, tls_material_changed).await)
    }

    /// Registry diff. Changed services swap listeners atomically (new bind
    /// first — a bad port keeps the old service serving). Services whose TLS
    /// material rotated rebuild with connection drop. `last` records the
    /// desired world INCLUDING failures so the next poll retries only those.
    pub async fn apply(&mut self, desired: Vec<DesiredService>, tls_changed: bool) -> ApplyOutcome {
        let mut outcome = ApplyOutcome::default();
        self.last = {
            let mut l = desired.clone();
            l.sort_by(|a, b| a.raw.name.cmp(&b.raw.name));
            l
        };

        let mut desired_map: HashMap<String, DesiredService> =
            desired.into_iter().map(|d| (d.raw.name.clone(), d)).collect();

        // Stop removed services (keep their connections — the quota hard-stop
        // blocks new connections, it never kills established ones).
        let names: Vec<String> = self.running.keys().cloned().collect();
        for name in names {
            if !desired_map.contains_key(&name) {
                if let Some(old) = self.running.remove(&name) {
                    old.stop(false).await;
                    outcome.removed += 1;
                }
            }
        }

        // Create or hot-swap the desired world.
        let mut names: Vec<String> = desired_map.keys().cloned().collect();
        names.sort();
        for name in names {
            let svc = desired_map.remove(&name).unwrap();
            match self.running.remove(&name) {
                Some(old) => {
                    // Dead-listener self-heal (gostapply's dead-service rule):
                    // an accept loop that died on a fatal accept error must be
                    // rebuilt even when the config is unchanged — otherwise a
                    // service would stay dead until the next config edit.
                    let dead = old.is_dead();
                    let config_changed = old.desired.raw != svc.raw
                        || old.listener_addr.port() != svc.listen.port()
                        || (tls_changed && svc.tls.is_some());
                    if !dead && !config_changed {
                        self.running.insert(name, old);
                        continue;
                    }
                    // A pure heal keeps live connections: the accept loop
                    // died, not the established tasks, and no cert rotation
                    // happened. Config-change rebuilds of TLS services still
                    // drop (the new acceptor re-embeds the certificates).
                    let drop_conns = config_changed && svc.tls.is_some();
                    // Same-port rebuilds must stop the old listener FIRST
                    // (double-bind is EADDRINUSE); different ports swap
                    // zero-downtime — the new listener is proven before the
                    // old stops, so a bad new port keeps the old serving.
                    let same_port = old.listener_addr.port() == svc.listen.port();
                    let mut old = Some(old);
                    if same_port {
                        old.take().expect("just set").stop(drop_conns).await;
                    }
                    match ServiceHandle::spawn(svc, self.material.as_ref(), self.stats.clone()) {
                        Ok(new_handle) => {
                            if let Some(old) = old.take() {
                                old.stop(drop_conns).await;
                            }
                            self.running.insert(name.clone(), new_handle);
                            outcome.updated += 1;
                        }
                        Err(err) => {
                            // Keep the old service serving; the failure is
                            // visible as apply_failed and retried next poll.
                            outcome.failures.push((name.clone(), err.to_string()));
                            match old.take() {
                                Some(old) => {
                                    self.running.insert(name, old);
                                }
                                None => {
                                    // Same-port path: the old listener is
                                    // already closed — the service is down.
                                    tracing::error!(
                                        service = name,
                                        "same-port rebuild failed after stopping the old listener: {err}"
                                    );
                                }
                            }
                        }
                    }
                }
                None => match ServiceHandle::spawn(svc, self.material.as_ref(), self.stats.clone()) {
                    Ok(handle) => {
                        self.running.insert(name, handle);
                        outcome.created += 1;
                    }
                    Err(err) => {
                        outcome.failures.push((name.clone(), err.to_string()));
                    }
                },
            }
        }

        self.failures = outcome.failures.clone();
        outcome
    }

    /// Panel restart directive: rebuild ONE service from the last desired
    /// config, dropping its live connections. Unknown names no-op.
    pub async fn restart(&mut self, name: &str) -> bool {
        if let Some(old) = self.running.remove(name) {
            match old.restart(self.material.as_ref(), self.stats.clone()).await {
                Ok(handle) => {
                    self.running.insert(name.to_string(), handle);
                    self.failures.retain(|(n, _)| n != name);
                    true
                }
                Err(err) => {
                    tracing::error!(service = name, "restart failed: {err}");
                    self.failures.push((name.to_string(), err.to_string()));
                    false
                }
            }
        } else if let Some(desired) = self.last.iter().find(|d| d.raw.name == name).cloned() {
            // apply_failed service: a restart directive is a manual retry.
            match ServiceHandle::spawn(desired, self.material.as_ref(), self.stats.clone()) {
                Ok(handle) => {
                    self.running.insert(name.to_string(), handle);
                    self.failures.retain(|(n, _)| n != name);
                    true
                }
                Err(err) => {
                    tracing::error!(service = name, "restart failed: {err}");
                    false
                }
            }
        } else {
            tracing::warn!(service = name, "restart directive for unknown service (no-op)");
            false
        }
    }

    /// Full health snapshot: one row per service of the last desired world —
    /// running, failed (accept loop died), or apply_failed (bind/build
    /// failed; the server maps this to rule status = error). The server
    /// deletes rows for services absent here, so it must cover `last`.
    pub fn health_snapshot(&self) -> Vec<ServiceHealthSample> {
        let mut out: Vec<ServiceHealthSample> = self
            .running
            .values()
            .map(|h| {
                let (state, error) = h.health.state();
                ServiceHealthSample {
                    service: h.desired.raw.name.clone(),
                    state: state.to_string(),
                    error: error.unwrap_or_default(),
                }
            })
            .collect();
        for (name, error) in &self.failures {
            if !self.running.contains_key(name) {
                out.push(ServiceHealthSample {
                    service: name.clone(),
                    state: "apply_failed".into(),
                    error: error.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.service.cmp(&b.service));
        out
    }

    pub async fn shutdown(&mut self) {
        for (_, handle) in self.running.drain() {
            handle.stop(false).await;
        }
    }

    pub fn service_count(&self) -> usize {
        self.running.len()
    }
}

/// Shared handle for the control loop (apply/restart from WS events, health
/// snapshots from the flush loop).
pub type SharedSupervisor = Arc<Mutex<Supervisor>>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::model::{NodeInfo, RealmNodeConfig, RealmService};
    use crate::stats::StatsRegistry;

    /// Echo server on an ephemeral port; returns the port.
    async fn echo_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                if sock.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        port
    }

    /// Grab a free listen port for the service (bind + release).
    async fn free_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    fn config(port: u16, target: u16) -> RealmNodeConfig {
        RealmNodeConfig {
            agent: "realm".into(),
            node: NodeInfo { id: 1, name: "n".into() },
            services: vec![RealmService {
                name: "service-1".into(),
                listen_host: "127.0.0.1".into(),
                listen_port: port,
                target_host: "127.0.0.1".into(),
                target_port: target,
                extra_targets: vec![],
                balance: None,
                tls_side: None,
                alpn: vec![],
                connect_timeout_s: None,
            }],
            tls_material: None,
        }
    }

    async fn roundtrip(sock: &mut tokio::net::TcpStream, payload: &[u8]) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        sock.write_all(payload).await.unwrap();
        let mut back = vec![0u8; payload.len()];
        sock.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, payload);
    }

    #[tokio::test]
    async fn unchanged_config_keeps_the_service() {
        let target = echo_server().await;
        let port = free_port().await;
        let cfg = config(port, target);
        let mut sv = Supervisor::new(StatsRegistry::new());

        let first = sv.apply_config(&cfg, false).await.unwrap();
        assert!(first.ok());
        assert_eq!(first.created, 1);

        // The identical config must not rebuild anything (the heal must not
        // over-trigger on healthy services).
        let again = sv.apply_config(&cfg, false).await.unwrap();
        assert!(again.ok());
        assert_eq!(again.created, 0);
        assert_eq!(again.updated, 0);
        assert_eq!(sv.service_count(), 1);

        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        roundtrip(&mut client, b"still-serving").await;
    }

    #[tokio::test]
    async fn dead_listener_self_heals_and_keeps_live_connections() {
        let target = echo_server().await;
        let port = free_port().await;
        let cfg = config(port, target);
        let mut sv = Supervisor::new(StatsRegistry::new());

        let first = sv.apply_config(&cfg, false).await.unwrap();
        assert_eq!(first.created, 1);

        let mut client1 = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        roundtrip(&mut client1, b"before-heal").await;

        // Kill the accept loop the way a fatal accept error does: task exits,
        // listener socket closes, established tasks keep running.
        sv.running.get_mut("service-1").unwrap().kill_accept_loop_for_test();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !sv.running.get("service-1").unwrap().is_dead() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("accept loop must die");

        // Live connections survive the loop's death AND the heal.
        roundtrip(&mut client1, b"during-dead").await;

        // Next apply (unchanged config) rebuilds exactly the dead service.
        let healed = sv.apply_config(&cfg, false).await.unwrap();
        assert!(healed.ok(), "failures: {:?}", healed.failures);
        assert_eq!(healed.updated, 1);
        assert!(!sv.running.get("service-1").unwrap().is_dead());

        // The listener accepts again; the pre-heal connection still works.
        let mut client2 = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        roundtrip(&mut client2, b"after-heal").await;
        roundtrip(&mut client1, b"after-heal-old-conn").await;
    }
}
