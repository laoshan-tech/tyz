import { z } from "zod";
import {
  type Endpoint,
  ForwardMode,
  type Package,
  type RelayNode,
  type RelayRule,
  RelayRuleStatus,
  type RuleQuota,
  type Tunnel,
  type User,
  UserStatus,
  type UserSubscription,
} from "./entities";
import type { GostStatsSample } from "./schemas";
import {
  chainTypeSchema,
  forwardModeSchema,
  limiterConfigSchema,
  relayRuleStatusSchema,
  transportSchema,
  userStatusSchema,
} from "./schemas";

// ---- Admin auth ----

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// ---- First-run setup (admin bootstrap) ----

/** Cookie/ASCII-safe: the username also rides inside the session cookie value. */
export const setupSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/, "用户名需 3-32 位字母/数字/下划线/连字符"),
  password: z.string().min(8, "密码至少 8 位").max(128),
});
export type SetupInput = z.infer<typeof setupSchema>;

export interface SetupStatusResponse {
  /** True once any role='admin' user exists (DB account login is the only path). */
  initialized: boolean;
  /** False when the users table is missing — migrations have not run yet. */
  schema_ready: boolean;
}

/** PUT /api/admin/me/password body: change the logged-in admin's own password. */
export const changePasswordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8, "密码至少 8 位").max(128),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---- Node CRUD ----

const tlsConfigInputSchema = z.object({
  commonName: z.string().optional(),
  organization: z.string().optional(),
});

export const createNodeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  address: z.string().min(1),
  display_address: z.string().optional(),
  version: z.string().optional(),
  level: z.number().int().nonnegative().default(0),
  is_public: z.boolean().default(false),
  ports: z
    .string()
    .regex(/^\d+-\d+$/, "ports must look like '10000-20000'")
    .default("10000-20000"),
  traffic_limit: z.number().int().nonnegative().default(0),
  rate: z.number().min(0, "计费倍率范围 0-100").max(100, "计费倍率范围 0-100").default(1),
  custom_cfg: z.unknown().optional(),
  tls_config: tlsConfigInputSchema.optional(),
});
export const updateNodeSchema = createNodeSchema.partial();
export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;

/** Node as seen by the admin panel: entity fields + config version + token hint. */
export interface NodeWithMeta extends RelayNode {
  config_version: number | null;
  token_hint: string;
}

/** Full node token — returned by create/rotate and by the reveal endpoint. */
export interface NodeToken {
  id: number;
  token: string;
}

/** GET /api/admin/nodes/:id/token — on-demand reveal behind the panel's masked display. */
export interface NodeTokenResponse {
  token: string | null;
}

// ---- Tunnel CRUD ----

export const createTunnelSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  ingress_display_address: z.string().optional(),
  // forward_mode is retired (realm agent renders raw semantics for every
  // tunnel); the server always stores 'raw'. The field is no longer accepted.
  tls_enabled: z.boolean().default(false),
});
export const updateTunnelSchema = createTunnelSchema.partial();
export type CreateTunnelInput = z.infer<typeof createTunnelSchema>;
export type UpdateTunnelInput = z.infer<typeof updateTunnelSchema>;

/**
 * Tunnel as listed by the admin panel: entity + derived chain count. The
 * count drives the effective-mode display — a single-hop tunnel (one `in`
 * chain, no exit) always renders as direct tcp forwarding regardless of the
 * stored forward_mode, so the panel shows it as 裸转发 instead of relay.
 */
export interface TunnelWithMeta extends Tunnel {
  chain_count: number;
}

// ---- Chain CRUD ----

export const createChainSchema = z.object({
  tunnel_id: z.number().int().positive(),
  node_id: z.number().int().positive(),
  // The realm data plane has no hop chaining: only in (entry) and out (exit)
  // links exist; several out links form the tunnel's exit candidate set (LB).
  chain_type: chainTypeSchema.refine((v) => v !== "chain", "中链（多跳）已不支持"),
  // kaminari speaks TLS only; raw stays plaintext.
  transport: transportSchema.refine((v) => v === "raw" || v === "tls", "仅支持 raw / tls 传输"),
  index: z.number().int().nonnegative(),
  strategy: z.enum(["round", "iphash"]).default("round"),
  port: z.number().int().nonnegative().default(0),
});
export const updateChainSchema = createChainSchema.partial();
export type CreateChainInput = z.infer<typeof createChainSchema>;
export type UpdateChainInput = z.infer<typeof updateChainSchema>;

// ---- Relay rule CRUD ----

export const createRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  listen_port: z.number().int().positive(),
  /** Every rule is tunnel-bound — a rule outside any tunnel is never part of a
   * node config (aggregation selects rules BY tunnel). Single-node direct
   * forwarding is a one-in-chain tunnel. Legacy NULL rows may exist. */
  tunnel_id: z.number().int().positive(),
  targets: z.string().min(1),
  /** Stored endpoint to forward to; when set, the server overrides `targets`
   * with the endpoint's composed address. null = manual address. */
  endpoint_id: z.number().int().positive().nullable().optional(),
  user_id: z.number().int().positive().nullable().optional(),
  status: relayRuleStatusSchema.default(RelayRuleStatus.CREATED),
  /** raw-mode tunnels: dedicated exit-side port. 0 = auto-allocate. */
  exit_port: z.number().int().min(0).max(65535).default(0),
  limit: limiterConfigSchema.nullable().optional(),
});
export const updateRuleSchema = createRuleSchema.partial();
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// ---- Target endpoints ----

export const createEndpointSchema = z.object({
  name: z.string().min(1),
  host: z
    .string()
    .min(1)
    .refine((v) => !/\s/.test(v) && !v.includes("://"), "主机名不能包含空格或协议前缀"),
  port: z.number().int().min(1).max(65535),
  note: z.string().optional(),
});
export const updateEndpointSchema = createEndpointSchema.partial();
export type CreateEndpointInput = z.infer<typeof createEndpointSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;

/** GET /endpoints row: entity + how many rules reference it (drives delete protection). */
export interface EndpointWithMeta extends Endpoint {
  rule_count: number;
}

// ---- Users & packages ----

export const createUserSchema = z.object({
  name: z.string().min(1),
  note: z.string().optional(),
  status: userStatusSchema.default(UserStatus.ACTIVE),
});
export const updateUserSchema = createUserSchema.partial();
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

const idList = z.array(z.number().int().positive()).nullable().optional();

export const createPackageSchema = z.object({
  name: z.string().min(1),
  note: z.string().optional(),
  traffic_bytes: z.number().int().nonnegative().default(0),
  period_days: z.number().int().nonnegative().default(0),
  node_ids: idList, // null/omitted = unrestricted node access
  tunnel_ids: idList, // null/omitted = unrestricted tunnel access
  max_rules: z.number().int().nonnegative().default(0),
});
export const updatePackageSchema = createPackageSchema.partial();
export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const subscribeSchema = z.object({
  package_id: z.number().int().positive(),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

// ---- Link TLS (platform-issued certs) ----

export const setTlsDomainSchema = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/, {
      message: "必须是合法域名，如 relay.example.com",
    }),
});
export type SetTlsDomainInput = z.infer<typeof setTlsDomainSchema>;

/** Observable certificate profile — issuer identity strings and validity. */
export interface TlsProfile {
  ca_common_name: string;
  /** "" = the CA subject omits the O attribute. */
  ca_organization: string;
  ca_validity_days: number;
  leaf_validity_days: number;
}

/**
 * PUT /settings/tls-profile — every field optional (unset fields keep their
 * current value). With no stored material the full set is issued immediately
 * ("issued" in the response); otherwise changing CA identity (CN/O/CA
 * validity) rotates the whole material set, and changing only the leaf
 * validity re-issues the leaves.
 */
export const setTlsProfileSchema = z.object({
  ca_common_name: z.string().trim().min(1).max(64).optional(),
  ca_organization: z.string().trim().max(64).optional(),
  ca_validity_days: z.number().int().min(366).max(7300).optional(),
  leaf_validity_days: z.number().int().min(30).max(1825).optional(),
});
export type SetTlsProfileInput = z.infer<typeof setTlsProfileSchema>;

/** GET /tls/status response body — expiry metadata + profile, never key material. */
export interface TlsStatus {
  domain: string | null;
  ca_not_after: string | null;
  server_not_after: string | null;
  client_not_after: string | null;
  profile: TlsProfile;
}

/** Rule row as listed by the admin panel, with the derived quota state of its owner. */
export interface AdminRuleRow extends RelayRule {
  /** True when the owner's allowance currently hard-stops this rule (excluded from node configs). */
  quota_stopped?: boolean;
  quota_reason?: "user_disabled" | "no_subscription" | "expired" | "exhausted";
}

// ---- Users & packages (API response shapes) ----

export interface UserListItem extends User {
  subscription: { package_id: number; package_name: string; expired: boolean } | null;
}

/** GET /users/:id response body. */
export interface UserDetail {
  user: User;
  subscription: { subscription: UserSubscription; pkg: Package; expired: boolean } | null;
  decision: QuotaDecision;
  rules: RuleQuotaStatus[];
}

export interface QuotaDecision {
  stopped: boolean;
  reason?: "user_disabled" | "no_subscription" | "expired" | "exhausted";
  /** Shared per-user quota; present only for metered, non-stopped owners. */
  quota?: RuleQuota;
}

export interface RuleQuotaStatus {
  rule_id: number;
  rule_name: string;
  used_bytes: number;
}

export interface ServiceHealthRow {
  node_id: number;
  service: string;
  state: string;
  error: string | null;
  reported_at: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
}

// ---- Stats ----

export interface NodeStatsRow {
  id: number;
  service: string;
  stats: GostStatsSample;
  reported_at: string;
}

// ---- Dashboard ----

/** GET /api/admin/dashboard/summary response body (read-only aggregation). */
export interface DashboardSummary {
  counts: {
    nodes: number;
    tunnels: number;
    rules: {
      total: number;
      running: number;
      paused: number;
      created: number;
      error: number;
      /** Derived quota hard-stops (dropped from node configs), independent of status. */
      quota_stopped: number;
    };
    users: { total: number; active: number; disabled: number; subscribed: number };
  };
  nodes_health: {
    node_id: number;
    name: string;
    /** Services present in the node's latest health snapshot (0 = agent idle/offline). */
    services: number;
    ready: number;
    /** failed + apply_failed states. */
    failed: number;
    /** Max concurrent connections across the node's services over the last 24h. */
    conn_peak_24h: number;
    last_report: string | null;
  }[];
  traffic: {
    today: { upload: number; download: number };
    yesterday: { upload: number; download: number };
  };
}

/** GET /api/admin/dashboard/traffic row: hourly billed bytes, zero-filled across the window. */
export interface DashboardTrafficPoint {
  /** UTC hour bucket, '2026-08-21T04:00:00.000Z'. */
  hour_ts: string;
  billed_upload: number;
  billed_download: number;
}
