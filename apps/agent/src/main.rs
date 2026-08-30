//! Binary entry: config, logging, rustls provider, then the library loop.

fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("tyz-agent {}", tyz_agent::VERSION);
        return;
    }
    let cfg = match tyz_agent::agentcfg::AgentConfig::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("tyz-agent: configuration error: {err}");
            std::process::exit(1);
        }
    };

    // rustls crypto provider (ring) — kaminari's TLS backend.
    kaminari::install_tls_provider();

    let filter = if cfg.debug { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter)),
        )
        .init();

    // GOST_API_ADDR died with GOST; warn once so stale deployments notice.
    if std::env::var("GOST_API_ADDR").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        tracing::warn!("GOST_API_ADDR is obsolete (no local admin API) and ignored");
    }

    tracing::info!(
        version = tyz_agent::VERSION,
        control_plane = cfg.control_plane_url,
        poll = ?cfg.poll_interval,
        flush = ?cfg.stats_flush_interval,
        "tyz-agent starting"
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(tyz_agent::run(cfg));
}
