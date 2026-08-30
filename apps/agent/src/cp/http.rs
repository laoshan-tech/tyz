//! Control-plane HTTP client: versioned config fetch (304 when unchanged) and
//! batched stats upload. One batch per call — chunking/retry lives in the
//! flush loop.

use std::time::Duration;

use crate::model::{AgentConfigResponse, StatsBatch};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// A misbehaving control plane must not balloon agent memory.
const MAX_CONFIG_BYTES: usize = 8 << 20;

pub struct CpClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("config poll failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("config response too large ({0} bytes > {1})")]
    TooLarge(usize, usize),
    #[error("config poll failed: {status} {body}")]
    Status { status: reqwest::StatusCode, body: String },
    #[error("config decode failed: {0}")]
    Decode(#[from] serde_json::Error),
}

pub enum Fetched {
    NotModified,
    Changed(Box<AgentConfigResponse>),
}

impl CpClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            token: token.to_string(),
            http: reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("reqwest client"),
        }
    }

    /// GET /api/agent/config?version=N — 304 → NotModified.
    pub async fn fetch_config(&self, version: i64) -> Result<Fetched, FetchError> {
        let resp = self
            .http
            .get(format!("{}/api/agent/config?version={version}", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Fetched::NotModified);
        }
        if status != reqwest::StatusCode::OK {
            return Err(FetchError::Status {
                status,
                body: trunc_body(resp).await,
            });
        }
        if let Some(len) = resp.content_length() {
            if len as usize > MAX_CONFIG_BYTES {
                return Err(FetchError::TooLarge(len as usize, MAX_CONFIG_BYTES));
            }
        }
        let bytes = resp.bytes().await?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(FetchError::TooLarge(bytes.len(), MAX_CONFIG_BYTES));
        }
        let parsed: AgentConfigResponse = serde_json::from_slice(&bytes)?;
        Ok(Fetched::Changed(Box::new(parsed)))
    }

    /// POST /api/agent/stats (one chunk; the first chunk of a flush carries
    /// the health snapshot).
    pub async fn upload_stats(
        &self,
        samples: &[crate::model::GostStatsSample],
        health: Option<&[crate::model::ServiceHealthSample]>,
    ) -> Result<(), String> {
        let body = StatsBatch {
            samples: samples.to_vec(),
            health: health.map(|h| h.to_vec()),
        };
        let resp = self
            .http
            .post(format!("{}/api/agent/stats", self.base_url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            // Keep a truncated body so validation errors are self-explanatory.
            let text = resp.text().await.unwrap_or_default();
            let text: String = text.chars().take(512).collect();
            return Err(format!("stats upload failed: {status}: {text}"));
        }
        Ok(())
    }
}

async fn trunc_body(resp: reqwest::Response) -> String {
    let text = resp.text().await.unwrap_or_default();
    text.chars().take(512).collect()
}
