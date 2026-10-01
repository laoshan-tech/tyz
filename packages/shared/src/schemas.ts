import { z } from "zod";
import { ChainType, ForwardMode, RelayRuleStatus, Transport, UserStatus } from "./entities";

export const chainTypeSchema = z.nativeEnum(ChainType);
export const transportSchema = z.nativeEnum(Transport);
export const forwardModeSchema = z.nativeEnum(ForwardMode);
export const relayRuleStatusSchema = z.nativeEnum(RelayRuleStatus);
export const userStatusSchema = z.nativeEnum(UserStatus);

const ipTrafficLimitSchema = z.object({
  ip: z.string(),
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
});

export const trafficLimiterSchema = z.object({
  service_in: z.number().nonnegative().optional(),
  service_out: z.number().nonnegative().optional(),
  conn_in: z.number().nonnegative().optional(),
  conn_out: z.number().nonnegative().optional(),
  ips: z.array(ipTrafficLimitSchema).optional(),
});

export const connectionLimiterSchema = z.object({
  service_limit: z.number().int().nonnegative().optional(),
  ips: z
    .object({
      ip: z.string(),
      limit: z.number().int().nonnegative(),
    })
    .array()
    .optional(),
});

export const limiterConfigSchema = z
  .object({
    traffic: trafficLimiterSchema.optional(),
    connection: connectionLimiterSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "limit must not be empty" });

export const tlsConfigSchema = z.object({
  commonName: z.string().optional(),
  organization: z.string().optional(),
});

export const tlsMaterialSchema = z.object({
  sni: z.string().min(1),
  ca_cert: z.string().min(1),
  server_cert: z.string().min(1),
  server_key: z.string().min(1),
  client_cert: z.string().min(1),
  client_key: z.string().min(1),
});

// ---- Realm agent payload (docs/agent-realm-rust-refactor.md §7.2) ----

export const realmTargetSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

export const realmServiceSchema = z.object({
  name: z.string().min(1),
  listen_host: z.string().min(1),
  listen_port: z.number().int().min(1).max(65535),
  target_host: z.string().min(1),
  target_port: z.number().int().min(1).max(65535),
  extra_targets: z.array(realmTargetSchema).optional(),
  balance: z.enum(["roundrobin", "iphash"]).optional(),
  tls_side: z.enum(["listen", "connect"]).optional(),
  alpn: z.array(z.string()).optional(),
  connect_timeout_s: z.number().int().positive().optional(),
  limit: z
    .object({
      service_in: z.number().int().positive().optional(),
      service_out: z.number().int().positive().optional(),
      conn_in: z.number().int().positive().optional(),
      conn_out: z.number().int().positive().optional(),
      max_conns: z.number().int().positive().optional(),
    })
    .optional(),
});

export const realmNodeConfigSchema = z.object({
  node: z.object({ id: z.number().int(), name: z.string() }),
  services: z.array(realmServiceSchema),
  tls_material: tlsMaterialSchema.optional(),
});

// ---- Agent-facing payloads (config delivered to a node) ----

export const relayNodePayloadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  address: z.string(),
  display_address: z.string().optional(),
  level: z.number().int(),
  is_public: z.boolean(),
  version: z.string().optional(),
  egress_traffic: z.number().nonnegative(),
  ingress_traffic: z.number().nonnegative(),
  traffic_limit: z.number().nonnegative(),
  rate: z.number().min(0.1).max(100).default(1),
  ports: z.string().regex(/^\d+-\d+$/, "ports must look like '10000-20000'"),
  custom_cfg: z.unknown().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

// The agent payload carries relay_auth_user/relay_auth_pass on top of the
// admin-visible Tunnel entity (the builder needs them for the relay protocol
// AuthConfig). New fields are optional: legacy cached payloads lack them.
export const tunnelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  ingress_display_address: z.string().optional(),
  forward_mode: forwardModeSchema.optional(),
  tls_enabled: z.boolean().optional(),
  relay_auth_user: z.string().optional(),
  relay_auth_pass: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const chainSchema = z.object({
  id: z.number().int(),
  tunnel_id: z.number().int(),
  node_id: z.number().int(),
  chain_type: chainTypeSchema,
  transport: transportSchema,
  index: z.number().int().nonnegative(),
  strategy: z.string(),
  port: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const relayRuleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  listen_port: z.number().int().positive(),
  tunnel_id: z.number().int().positive().optional(),
  user_id: z.number().int().positive().optional(),
  /** Present when the rule targets a stored endpoint; the Go side ignores it (targets is authoritative). */
  endpoint_id: z.number().int().positive().optional(),
  targets: z.string(),
  status: relayRuleStatusSchema,
  exit_port: z.number().int().min(0).max(65535).optional(),
  limit: limiterConfigSchema.nullable().optional(),
  quota: z
    .object({
      name: z.string().min(1),
      limit_bytes: z.number().int().positive(),
      starts_at: z.string(),
      expires_at: z.string().optional(),
    })
    .optional(),
  upload_traffic: z.number().nonnegative(),
  download_traffic: z.number().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const nodeConfigDataSchema = z.object({
  node: relayNodePayloadSchema,
  nodes: z.array(relayNodePayloadSchema).optional(),
  rules: z.array(relayRuleSchema),
  tunnels: z.array(tunnelSchema),
  chains: z.array(chainSchema),
  tls: tlsConfigSchema.optional(),
  tls_material: tlsMaterialSchema.optional(),
});

// ---- Agent stats reporting ----
//
// GOST v3 observers POST an envelope {"events":[...]} where each event is a
// status change or (with enableStats on the service) a periodic stats report.
// We only forward stats events to the control plane, flattened into samples.

// String caps bound request size for token-holders only — set generously so a
// legitimate (long GOST error, long client label) sample can never be rejected.
const gostStatsSampleSchema = z.object({
  service: z.string().max(256),
  client: z.string().max(256).optional(), // handler-level (per-client) stats only
  totalConns: z.number().int().nonnegative(),
  currentConns: z.number().int().nonnegative(),
  inputBytes: z.number().nonnegative(),
  outputBytes: z.number().nonnegative(),
  totalErrs: z.number().int().nonnegative(),
});

// Service runtime state rides the heartbeat channel (WS heartbeat message or
// POST /api/agent/heartbeat), NOT the stats batch — liveness and the service
// snapshot share one cadence, traffic stays event-driven.

const serviceHealthSampleSchema = z.object({
  service: z.string().max(256),
  state: z.string().max(32),
  error: z.string().max(2048).optional(),
});

export const agentStatsBatchSchema = z
  .object({
    // The agent marshals nil Go slices as JSON null — accept null alongside
    // absent (zod's .default only covers absence) and normalize to []. The cap
    // bounds ingest cost: the agent's stats buffer holds at most 1000 samples.
    samples: z
      .array(gostStatsSampleSchema)
      .max(1000)
      .nullish()
      .transform((v) => v ?? []),
  })
  .refine((v) => v.samples.length > 0, {
    message: "batch must carry samples",
  });

// Heartbeat payload: the full service-state snapshot, possibly empty (a node
// with zero deployed services still heartbeats — the empty snapshot is what
// clears stale service_health rows server-side). WS messages wrap this with a
// "type":"heartbeat" tag; zod strips the unknown key, so one schema serves
// both the WS path and POST /api/agent/heartbeat.
export const agentHeartbeatSchema = z.object({
  health: z
    .array(serviceHealthSampleSchema)
    .max(500)
    .nullish()
    .transform((v) => v ?? []),
});

export type GostStatsSample = z.infer<typeof gostStatsSampleSchema>;
export type ServiceHealthSample = z.infer<typeof serviceHealthSampleSchema>;
export type AgentStatsBatch = z.infer<typeof agentStatsBatchSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
