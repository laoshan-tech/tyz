//! Wire types for the control-plane contract. Field names are frozen: they
//! must stay byte-compatible with `@tyz/shared` (see the server's
//! agentStatsBatchSchema / RealmNodeConfig).

use serde::{Deserialize, Serialize};

// ---- GET /api/agent/config ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigResponse {
    pub version: i64,
    pub config: RealmNodeConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealmNodeConfig {
    /// Flavor discriminator; anything other than "realm" is refused by the
    /// control loop (a stale gost payload must never be applied).
    pub agent: String,
    pub node: NodeInfo,
    #[serde(default)]
    pub services: Vec<RealmService>,
    #[serde(default)]
    pub tls_material: Option<TlsMaterial>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeInfo {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealmService {
    pub name: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
    #[serde(default)]
    pub extra_targets: Vec<RealmTarget>,
    #[serde(default)]
    pub balance: Option<BalanceStrategy>,
    #[serde(default)]
    pub tls_side: Option<TlsSide>,
    #[serde(default)]
    pub alpn: Vec<String>,
    #[serde(default)]
    pub connect_timeout_s: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealmTarget {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BalanceStrategy {
    Roundrobin,
    Iphash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TlsSide {
    /// This service TERMINATES TLS on its listener (exit leg).
    Listen,
    /// This service DIALS with TLS toward its target (entry leg).
    Connect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TlsMaterial {
    pub sni: String,
    pub ca_cert: String,
    pub server_cert: String,
    pub server_key: String,
    pub client_cert: String,
    pub client_key: String,
}

// ---- POST /api/agent/stats ----

/// One cumulative counter snapshot per (service × client). The server folds
/// these into telescoping deltas; counters must therefore be monotonic within
/// a process lifetime (a restart re-anchors server-side, see traffic.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GostStatsSample {
    pub service: String,
    /// Empty string = service-level sample (the ONLY kind the billing ledger
    /// consumes); a client IP = per-client breakdown row.
    #[serde(default)]
    pub client: String,
    pub total_conns: u64,
    pub current_conns: u64,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub total_errs: u64,
}

/// Runtime state of one service, uploaded as a FULL snapshot alongside stats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceHealthSample {
    pub service: String,
    /// running | failed | apply_failed (a subset of the states the panel knows)
    pub state: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
}

/// Request body of POST /api/agent/stats. Empty vecs serialize as `[]` (never
/// `null` — the zod schema tolerates null, but [] is what we promise).
#[derive(Debug, Clone, Serialize)]
pub struct StatsBatch {
    pub samples: Vec<GostStatsSample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<Vec<ServiceHealthSample>>,
}

// ---- GET /api/agent/ws (downstream push messages) ----

#[derive(Debug, Clone, Deserialize)]
pub struct PushMessage {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub service: Option<String>,
}
