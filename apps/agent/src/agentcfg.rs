//! Environment / dotenv configuration. Variable names and semantics mirror the
//! legacy Go agent one-for-one so deployments swap the binary and nothing else.

use std::time::Duration;

/// Cloudflare's edge closes WebSockets idle > ~100s; the ping interval must
/// stay strictly below (the Go agent clamps at 90s).
const MAX_PING_INTERVAL: Duration = Duration::from_secs(89);

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub control_plane_url: String,
    pub node_token: String,
    pub poll_interval: Duration,
    pub stats_flush_interval: Duration,
    pub ws_enabled: bool,
    pub ws_probe_interval: Duration,
    pub ws_ping_interval: Duration,
    pub debug: bool,
}

fn env_str(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v.trim().to_string()),
        _ => Err(format!("{name} is required")),
    }
}

/// Parse a numeric env var; a malformed value (e.g. `1O000` with a letter O)
/// is a hard error, not a silent fallback — same policy as the Go agent.
fn env_ms(name: &str, default_ms: u64) -> Result<Duration, String> {
    match std::env::var(name) {
        Err(_) => Ok(Duration::from_millis(default_ms)),
        Ok(raw) => {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                return Ok(Duration::from_millis(default_ms));
            }
            let ms: u64 = raw
                .parse()
                .map_err(|_| format!("{name}={raw:?} is not a valid number"))?;
            if ms == 0 {
                return Err(format!("{name} must be > 0"));
            }
            Ok(Duration::from_millis(ms))
        }
    }
}

impl AgentConfig {
    pub fn from_env() -> Result<Self, String> {
        // .env in the working directory, real env vars win (dotenvy never
        // overwrites). Missing file is fine.
        let _ = dotenvy::dotenv();

        let mut url = env_str("CONTROL_PLANE_URL")?;
        while url.ends_with('/') {
            url.pop();
        }
        let node_token = env_str("NODE_TOKEN")?;

        let mut ws_ping_interval = env_ms("WS_PING_INTERVAL_MS", 60_000)?;
        if ws_ping_interval > MAX_PING_INTERVAL {
            ws_ping_interval = MAX_PING_INTERVAL;
        }

        Ok(Self {
            control_plane_url: url,
            node_token,
            poll_interval: env_ms("POLL_INTERVAL_MS", 10_000)?,
            stats_flush_interval: env_ms("STATS_FLUSH_INTERVAL_MS", 60_000)?,
            ws_enabled: std::env::var("WS_ENABLED")
                .map(|v| !v.trim().eq_ignore_ascii_case("false"))
                .unwrap_or(true),
            ws_probe_interval: env_ms("WS_PROBE_INTERVAL_MS", 60_000)?,
            ws_ping_interval,
            debug: std::env::var("DEBUG").map(|v| v.trim() == "true").unwrap_or(false),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_numbers_are_errors_not_fallbacks() {
        // SAFETY: tests run single-threaded per process.
        unsafe { std::env::set_var("TYZ_TEST_MS", "1O000") };
        let err = env_ms("TYZ_TEST_MS", 1000).unwrap_err();
        assert!(err.contains("not a valid number"));
        unsafe { std::env::remove_var("TYZ_TEST_MS") };
        assert_eq!(env_ms("TYZ_TEST_MS", 1000).unwrap(), Duration::from_millis(1000));
    }
}
