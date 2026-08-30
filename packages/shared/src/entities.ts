/**
 * Domain entity types shared between the control-plane server and node agents.
 * These mirror the D1 (SQLite) schema in apps/server/migrations.
 */

export enum ChainType {
  IN = "in",
  CHAIN = "chain",
  OUT = "out",
}

export enum Transport {
  RAW = "raw",
  WS = "ws",
  TLS = "tls",
  GRPC = "grpc",
  WSS = "wss",
  MTLS = "mtls",
  MWSS = "mwss",
}

/**
 * Transports that can carry a TLS-encrypted link (tunnels.tls_enabled, 2-hop
 * shape). The realm agent speaks kaminari TLS only, so this is exactly {tls};
 * kept as a set so call sites stay unchanged.
 */
export const TLS_LINK_TRANSPORTS: ReadonlySet<Transport> = new Set([Transport.TLS]);

export enum RelayRuleStatus {
  CREATED = "created",
  PAUSED = "paused",
  RUNNING = "running",
  ERROR = "error",
}

export enum UserStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

/**
 * Two-node tunnel forward mode. LEGACY column: the realm agent renders every
 * tunnel with raw (port-pair) semantics regardless of the stored value; admin
 * writes no longer accept 'relay' and always store 'raw'. Kept for schema
 * stability — see docs/agent-realm-rust-refactor.md §7.3.
 */
export enum ForwardMode {
  RELAY = "relay",
  RAW = "raw",
}

export interface RelayNode {
  id: number;
  name: string;
  description?: string;
  address: string;
  display_address?: string;
  level: number;
  is_public: boolean;
  version?: string;
  egress_traffic: number;
  ingress_traffic: number;
  traffic_limit: number;
  /** Traffic billing multiplier: charged bytes = round(real × rate). */
  rate: number;
  ports: string; // e.g., "10000-20000"
  custom_cfg?: unknown; // JSON object
  created_at: string;
  updated_at: string;
}

export interface Tunnel {
  id: number;
  name: string;
  description?: string;
  ingress_display_address?: string; // Optional entry address for IN chain
  forward_mode: ForwardMode;
  /** TLS-wrapped entry<->exit link (platform certs, mutual verification). */
  tls_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Tunnel as delivered to agents: the admin entity plus the relay-protocol
 * link credentials (the builder needs them for GOST AuthConfig). The
 * credentials never appear in admin-facing responses.
 */
export interface TunnelPayload extends Tunnel {
  relay_auth_user: string;
  relay_auth_pass: string;
}

export interface Chain {
  id: number;
  tunnel_id: number;
  node_id: number;
  chain_type: ChainType;
  transport: Transport;
  index: number; // Order in the chain
  strategy: string; // Load balancing strategy, e.g., "round"
  port: number; // Listening port (0 if auto-allocated)
  created_at: string;
  updated_at: string;
}

export interface RelayRule {
  id: number;
  name: string;
  description?: string;
  listen_port: number;
  tunnel_id?: number;
  /** Owning tenant; absent for admin-managed rules (no quota enforcement). */
  user_id?: number;
  targets: string; // Target address, e.g., "example.com:80"
  /**
   * Stored target endpoint this rule forwards to; absent = manually-entered
   * `targets`. While associated, `targets` mirrors `endpointAddress(endpoint)`
   * — the server re-syncs it (and recomputes affected tunnels) whenever the
   * endpoint's host/port change.
   */
  endpoint_id?: number;
  status: RelayRuleStatus;
  /**
   * raw-mode tunnels: the rule's dedicated listening port on the EXIT node.
   * 0 = deterministic auto-allocation from the exit node's port range.
   */
  exit_port: number;
  limit?: LimiterConfig; // JSON object for limiter configuration
  /** Traffic allowance computed by the control plane at push time. */
  quota?: RuleQuota;
  upload_traffic: number;
  download_traffic: number;
  created_at: string;
  updated_at: string;
}

/**
 * Traffic quota shared by every rule of one owner (GOST quota objects with
 * the same name share a single counter). `limit_bytes` is the REMAINING
 * allowance at computation time; the agent-side quota counts from its own
 * zero at push time, so the gate is pre-push usage (server ledger) +
 * post-push usage (agent counter). `expires_at` omitted = permanent package.
 */
export interface RuleQuota {
  name: string; // quota object name, e.g. quota-user-1
  limit_bytes: number;
  starts_at: string; // subscription activation time, RFC3339
  expires_at?: string; // RFC3339; empty for permanent packages
}

/**
 * Named forwarding destination (host + port) relay rules can reference instead
 * of a manually-entered address. `rule.targets` keeps its own copy of the
 * composed address so the agent config pipeline never joins this table.
 */
export interface Endpoint {
  id: number;
  name: string;
  host: string;
  port: number;
  note?: string;
  created_at: string;
  updated_at: string;
}

/** Compose the rule `targets` address; IPv6 hosts get bracketed (`[::1]:80`). */
export function endpointAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Purchasable plan. `traffic_bytes` 0 = unlimited traffic; `period_days` 0 =
 * permanent (never expires); `node_ids`/`tunnel_ids` null = unrestricted
 * access; `max_rules` 0 = unlimited rules.
 */
export interface Package {
  id: number;
  name: string;
  note?: string;
  traffic_bytes: number;
  period_days: number;
  node_ids: number[] | null;
  tunnel_ids: number[] | null;
  max_rules: number;
  created_at: string;
  updated_at: string;
}

/** Tenant owning relay rules; quota and access rights come from the subscription. */
export interface User {
  id: number;
  name: string;
  note?: string;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

/**
 * A user's active subscription (one per user). Switching/renewing a package
 * replaces the row with a fresh `activated_at` — the usage window restarts, so
 * historically used traffic is cleared (换购清零) on both the ledger and the
 * agent-side quota counter (whose restore only matches an identical window).
 * `package_name`/`traffic_bytes` are SNAPSHOTS frozen at subscribe time so
 * history stays interpretable after the package is renamed/edited.
 */
export interface UserSubscription {
  id: number;
  user_id: number;
  package_id: number;
  package_name: string;
  traffic_bytes: number;
  activated_at: string;
  expires_at: string | null; // null = permanent package
  created_at: string;
  updated_at: string;
}

// Limiter configuration types
export interface LimiterConfig {
  traffic?: TrafficLimiter;
  request?: RequestLimiter;
  connection?: ConnectionLimiter;
}

export interface TrafficLimiter {
  service_in?: number; // Service-level incoming traffic limit (bytes/s)
  service_out?: number; // Service-level outgoing traffic limit (bytes/s)
  conn_in?: number; // Connection-level incoming traffic limit (bytes/s)
  conn_out?: number; // Connection-level outgoing traffic limit (bytes/s)
  ips?: Array<{
    ip: string;
    in: number; // Incoming traffic limit for this IP (bytes/s)
    out: number; // Outgoing traffic limit for this IP (bytes/s)
  }>;
}

export interface RequestLimiter {
  service_rate?: number; // Service-level request rate limit (req/s)
  ips?: Array<{
    ip: string;
    rate: number; // Request rate limit for this IP (req/s)
  }>;
}

export interface ConnectionLimiter {
  service_limit?: number; // Service-level connection limit
  ips?: Array<{
    ip: string;
    limit: number; // Connection limit for this IP
  }>;
}

// TLS configuration attached to a node
export interface TlsConfig {
  commonName?: string;
  organization?: string;
}

/**
 * Platform-issued link TLS material, delivered to agents inside the config
 * payload whenever any of the node's tunnels has tls_enabled. The agent
 * writes the PEMs to its local certs directory and the generated GOST config
 * references them by file path (mutual TLS: exit listeners present the server
 * cert and verify clients against the CA; entry dialers present the client
 * cert and verify the exit against the CA).
 */
export interface TlsMaterial {
  sni: string;
  ca_cert: string;
  server_cert: string;
  server_key: string;
  client_cert: string;
  client_key: string;
}

// Complete node configuration delivered to agents
export interface NodeConfigData {
  node: RelayNode;
  /** Node records for every node the chains reference (incl. the recipient),
   * so agents resolve each hop's dial address from its own node record.
   * Optional: payloads without it fall back to `node` (legacy snapshots). */
  nodes?: RelayNode[];
  rules: RelayRule[];
  tunnels: TunnelPayload[];
  chains: Chain[];
  tls?: TlsConfig;
  /** Present only when at least one of the node's tunnels enables link TLS. */
  tls_material?: TlsMaterial;
}

// ---- Realm agent payload (docs/agent-realm-rust-refactor.md §8) ----

/** One forwarding destination of a realm service (LB candidates included). */
export interface RealmTarget {
  host: string; // IP or domain (resolved per connection on the agent)
  port: number;
}

/**
 * One managed realm forward: `listen_port → target` (+ optional extra targets
 * load-balanced per connection). `tls_side` marks which end of an encrypted
 * link this service is: "listen" = TLS server (exit leg), "connect" = TLS
 * client dialing the exit (entry leg).
 */
export interface RealmService {
  name: string; // service-{ruleId} — billing/status/restart all key off this
  listen_host: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  /** Additional exit candidates (LB); only when the tunnel has several out links. */
  extra_targets?: RealmTarget[];
  /** Selection strategy over [target, extra_targets]; default roundrobin. */
  balance?: "roundrobin" | "iphash";
  tls_side?: "listen" | "connect";
  /** Offered ALPN on the TLS client leg (kaminari option); unset = none. */
  alpn?: string[];
  connect_timeout_s?: number; // default 5 (realm's network.tcp_timeout)
}

/** Config payload consumed by the Rust realm agent (GET /api/agent/config). */
export interface RealmNodeConfig {
  agent: "realm";
  node: { id: number; name: string };
  services: RealmService[];
  /** Present iff any service carries tls_side (same set for both legs). */
  tls_material?: TlsMaterial;
}
