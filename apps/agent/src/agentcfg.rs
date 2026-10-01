//! Environment / dotenv configuration. Variable names and semantics mirror the
//! legacy Go agent one-for-one so deployments swap the binary and nothing else.

use std::time::Duration;

/// Node heartbeat cadence — deliberately NOT configurable: one fixed value
/// keeps the server-side offline threshold (5 min) a simple constant and the
/// fleet uniform. 60s stays well under Cloudflare's ~100s idle-socket close
/// (the WS heartbeat doubles as the keepalive frame).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub control_plane_url: String,
    pub node_token: String,
    pub poll_interval: Duration,
    pub stats_flush_interval: Duration,
    pub ws_enabled: bool,
    pub ws_probe_interval: Duration,
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

        Ok(Self {
            control_plane_url: url,
            node_token,
            poll_interval: env_ms("POLL_INTERVAL_MS", 10_000)?,
            stats_flush_interval: env_ms("STATS_FLUSH_INTERVAL_MS", 60_000)?,
            ws_enabled: std::env::var("WS_ENABLED")
                .map(|v| !v.trim().eq_ignore_ascii_case("false"))
                .unwrap_or(true),
            ws_probe_interval: env_ms("WS_PROBE_INTERVAL_MS", 60_000)?,
            debug: std::env::var("DEBUG")
                .map(|v| v.trim() == "true")
                .unwrap_or(false),
        })
    }

    /// Push-channel URL for the WS client. CONTROL_PLANE_URL is an http(s)
    /// base shared with the HTTP client; tungstenite only accepts ws/wss
    /// schemes (the Go agent's dialer converted silently), so convert here.
    pub fn ws_url(&self) -> String {
        let base = if let Some(rest) = self.control_plane_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.control_plane_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.control_plane_url.clone()
        };
        format!("{base}/api/agent/ws")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with_url(url: &str) -> AgentConfig {
        AgentConfig {
            control_plane_url: url.to_string(),
            node_token: String::new(),
            poll_interval: Duration::from_secs(10),
            stats_flush_interval: Duration::from_secs(60),
            ws_enabled: true,
            ws_probe_interval: Duration::from_secs(60),
            debug: false,
        }
    }

    #[test]
    fn ws_url_converts_http_schemes() {
        assert_eq!(
            cfg_with_url("https://example.com").ws_url(),
            "wss://example.com/api/agent/ws"
        );
        assert_eq!(
            cfg_with_url("http://127.0.0.1:8787").ws_url(),
            "ws://127.0.0.1:8787/api/agent/ws"
        );
        // explicit ws/wss and scheme-less bases pass through untouched
        assert_eq!(
            cfg_with_url("wss://example.com").ws_url(),
            "wss://example.com/api/agent/ws"
        );
        assert_eq!(
            cfg_with_url("ws://127.0.0.1:8787").ws_url(),
            "ws://127.0.0.1:8787/api/agent/ws"
        );
    }

    #[test]
    fn malformed_numbers_are_errors_not_fallbacks() {
        // SAFETY: tests run single-threaded per process.
        unsafe { std::env::set_var("TYZ_TEST_MS", "1O000") };
        let err = env_ms("TYZ_TEST_MS", 1000).unwrap_err();
        assert!(err.contains("not a valid number"));
        unsafe { std::env::remove_var("TYZ_TEST_MS") };
        assert_eq!(
            env_ms("TYZ_TEST_MS", 1000).unwrap(),
            Duration::from_millis(1000)
        );
    }
}
