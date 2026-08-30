//! tyz-agent library: realm-based Rust relay node agent.
//!
//! Data plane: realm semantics — plain TCP forwarding on the Linux splice
//! zero-copy path (a counting specialization of realm_io's engine), TLS links
//! via kaminari (realm's transport library), multi-exit load balancing via
//! realm_lb. Control plane: config sync over the existing /api/agent
//! endpoints (WS push + HTTP fallback), traffic stats upload. See
//! docs/agent-realm-rust-refactor.md.

pub mod agentcfg;
pub mod certs;
pub mod control;
pub mod cp;
pub mod model;
pub mod runtime;
pub mod stats;
pub mod store;
pub mod translate;

use std::sync::Arc;

use tokio::sync::{mpsc, watch, Mutex};

/// Agent version stamped at build time (`-ldflags` equivalent via TYZ_VERSION).
pub const VERSION: &str = match option_env!("TYZ_VERSION") {
    Some(v) => v,
    None => "dev",
};

/// Wire everything and run until a shutdown signal. The rustls provider must
/// already be installed (see main).
pub async fn run(cfg: agentcfg::AgentConfig) {
    let stats = stats::StatsRegistry::new();
    let supervisor: runtime::SharedSupervisor = Arc::new(Mutex::new(runtime::Supervisor::new(stats.clone())));
    let cp = Arc::new(cp::http::CpClient::new(&cfg.control_plane_url, &cfg.node_token));

    // Offline bootstrap: replay the cached config so a node survives a
    // control-plane outage; its version becomes the polling baseline (an
    // unchanged config then costs exactly one 304). A gost-era or corrupt
    // cache is skipped — fresh start.
    let mut baseline_version: i64 = 0;
    if let Some(cached) = store::load() {
        if cached.config.agent == "realm" {
            if let Some(material) = &cached.config.tls_material {
                let _ = certs::ensure(material);
            }
            let mut sv = supervisor.lock().await;
            match sv.apply_config(&cached.config, false).await {
                Ok(outcome) => {
                    for (name, err) in &outcome.failures {
                        tracing::warn!(service = name, "offline bootstrap partial apply: {err}");
                    }
                    tracing::info!(
                        version = cached.version,
                        services = sv.service_count(),
                        "offline bootstrap applied from cache"
                    );
                }
                Err(err) => tracing::warn!("offline bootstrap rejected: {err}"),
            }
            baseline_version = cached.version;
        } else {
            tracing::warn!("cached config is not realm-flavored; starting from scratch");
        }
    }

    // WS push channel → control-loop wakeups.
    let (wake_tx, wake_rx) = mpsc::channel(64);
    let ws = if cfg.ws_enabled {
        let events = {
            let wake_tx = wake_tx.clone();
            let (tx, mut rx) = mpsc::channel(64);
            tokio::spawn(async move {
                while let Some(event) = rx.recv().await {
                    let _ = wake_tx.send(control::Wake::WsEvent(event)).await;
                }
            });
            tx
        };
        cp::ws::WsChannel::spawn(
            cp::ws::WsOpts {
                url: format!("{}/api/agent/ws", cfg.control_plane_url),
                token: cfg.node_token.clone(),
                ping_interval: cfg.ws_ping_interval,
                probe_interval: cfg.ws_probe_interval,
            },
            events,
        )
    } else {
        tracing::info!("WS_ENABLED=false — pure HTTP polling");
        cp::ws::WsChannel::stub()
    };

    let control = control::Control {
        cfg: cfg.clone(),
        cp: cp.clone(),
        supervisor: supervisor.clone(),
        version: baseline_version,
    };
    let control_task = tokio::spawn(control.run(wake_rx, ws));

    // Flush loop + shutdown plumbing.
    let flush = control::Flush::new(cp.clone(), supervisor.clone(), stats.clone(), cfg.stats_flush_interval);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let flush_task = tokio::spawn(flush.run(shutdown_rx));

    // Signal handling: SIGTERM/SIGINT → final flush → stop services.
    wait_for_shutdown().await;
    tracing::info!("shutdown signal received");
    let _ = shutdown_tx.send(true);
    let _ = wake_tx.send(control::Wake::Shutdown).await;

    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        control_task.abort();
        let _ = control_task.await;
    })
    .await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let _ = flush_task.await;
    })
    .await;

    supervisor.lock().await.shutdown().await;
    tracing::info!("shutdown complete");
}

async fn wait_for_shutdown() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}
