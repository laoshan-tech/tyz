import type { Chain, RealmNodeConfig, RealmService, RealmTarget, RelayNode, RelayRule, Tunnel } from "@tyz/shared";
import { ChainType, Transport } from "@tyz/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { applyRuleQuotas } from "../services/quota";
import { ensureTlsMaterial } from "../services/tls";
import type { Database } from "./index";
import { chains, nodeConfigs, relayNodes, relayRules, tunnels } from "./schema";

/**
 * Data access layer on Drizzle. Column typing (boolean/json modes, enum-ish
 * $type casts, the chains.idx -> index alias) comes from schema.ts; the small
 * `to*` helpers below only fold nullable columns to the `field?: T` shape the
 * shared entity types (and existing API responses) use.
 */

function opt<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

type NodeRow = typeof relayNodes.$inferSelect;
export type TunnelRow = typeof tunnels.$inferSelect;
type RuleRow = typeof relayRules.$inferSelect;

export function toRelayNode<T extends Omit<NodeRow, "token" | "tls_config" | "token_hint">>(row: T): RelayNode {
  return {
    ...row,
    description: opt(row.description),
    display_address: opt(row.display_address),
    version: opt(row.version),
    custom_cfg: opt(row.custom_cfg),
  };
}

/**
 * Admin-facing Tunnel entity. relay_auth_user/relay_auth_pass are stripped —
 * the credentials travel only inside the agent payload (toTunnelPayload).
 */
export function toTunnel(row: TunnelRow): Tunnel {
  const { relay_auth_user: _u, relay_auth_pass: _p, ...entity } = row;
  return {
    ...entity,
    description: opt(entity.description),
    ingress_display_address: opt(entity.ingress_display_address),
  };
}

export function toRelayRule(row: RuleRow): RelayRule {
  return {
    ...row,
    description: opt(row.description),
    tunnel_id: opt(row.tunnel_id),
    user_id: opt(row.user_id),
    endpoint_id: opt(row.endpoint_id),
    limit: opt(row.limit),
  };
}

// ---- Queries used by the config aggregator ----

/**
 * Columns of relay_nodes that map onto the public RelayNode entity.
 * NEVER select token/tls_config here — this list feeds BOTH admin responses and
 * the agent config snapshot (config_json); the token is revealed only through
 * the dedicated GET /nodes/:id/token endpoint.
 */
export const nodeEntityColumns = {
  id: relayNodes.id,
  name: relayNodes.name,
  description: relayNodes.description,
  address: relayNodes.address,
  display_address: relayNodes.display_address,
  level: relayNodes.level,
  is_public: relayNodes.is_public,
  version: relayNodes.version,
  egress_traffic: relayNodes.egress_traffic,
  ingress_traffic: relayNodes.ingress_traffic,
  traffic_limit: relayNodes.traffic_limit,
  rate: relayNodes.rate,
  ports: relayNodes.ports,
  custom_cfg: relayNodes.custom_cfg,
  created_at: relayNodes.created_at,
  updated_at: relayNodes.updated_at,
};

export async function getNode(db: Database, id: number): Promise<RelayNode | null> {
  const row = await db.select(nodeEntityColumns).from(relayNodes).where(eq(relayNodes.id, id)).get();
  return row ? toRelayNode(row) : null;
}

export async function getNodesByIds(db: Database, ids: number[]): Promise<RelayNode[]> {
  if (ids.length === 0) return [];
  const rows = await db.select(nodeEntityColumns).from(relayNodes).where(inArray(relayNodes.id, ids)).all();
  return rows.map(toRelayNode);
}

export async function getChainsForNode(db: Database, nodeId: number): Promise<Chain[]> {
  const rows = await db.select().from(chains).where(eq(chains.node_id, nodeId)).all();
  return rows;
}

export async function getTunnelsByIds(db: Database, ids: number[]): Promise<TunnelRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(tunnels).where(inArray(tunnels.id, ids)).all();
}

export async function getChainsForTunnels(db: Database, tunnelIds: number[]): Promise<Chain[]> {
  if (tunnelIds.length === 0) return [];
  const rows = await db.select().from(chains).where(inArray(chains.tunnel_id, tunnelIds)).orderBy(chains.index).all();
  return rows;
}

export async function getRulesForTunnels(db: Database, tunnelIds: number[]): Promise<RelayRule[]> {
  if (tunnelIds.length === 0) return [];
  const rows = await db.select().from(relayRules).where(inArray(relayRules.tunnel_id, tunnelIds)).all();
  return rows.map(toRelayRule);
}

// ---- node_configs snapshot ----

export async function getNodeConfigSnapshot(
  db: Database,
  nodeId: number,
): Promise<{ version: number; configJson: string } | null> {
  const row = await db
    .select({ version: nodeConfigs.version, configJson: nodeConfigs.config_json })
    .from(nodeConfigs)
    .where(eq(nodeConfigs.node_id, nodeId))
    .get();
  return row ?? null;
}

export async function upsertNodeConfigSnapshot(
  db: Database,
  nodeId: number,
  configJson: string,
  now: string,
): Promise<void> {
  // Version = epoch seconds baseline, bumped past any existing row. This stays
  // monotonic even if the snapshot row was deleted (recreate yields a fresh,
  // larger epoch) so agents never miss a regenerated config via a stale 304.
  // Kept as raw SQL: the CASE-on-conflict upsert is clearer verbatim.
  await db.run(sql`
    INSERT INTO node_configs (node_id, version, config_json, updated_at)
    VALUES (${nodeId}, ${Math.floor(Date.now() / 1000)}, ${configJson}, ${now})
    ON CONFLICT(node_id) DO UPDATE SET
      version = CASE WHEN node_configs.version >= excluded.version THEN node_configs.version + 1 ELSE excluded.version END,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);
}

export async function deleteNodeConfigSnapshot(db: Database, nodeId: number): Promise<void> {
  await db.delete(nodeConfigs).where(eq(nodeConfigs.node_id, nodeId)).run();
}

// ---- Realm config renderer (docs/agent-realm-rust-refactor.md §7.4) ----

/**
 * Deterministic raw-mode exit port: start + ((ruleId*31 + nodeId) % range).
 * Same formula the legacy Go builder used on both ends; now computed once
 * here and delivered as an explicit value. Collisions surface as
 * apply_failed service health on the agent (warned below).
 */
function allocatePortForRule(nodePorts: string, ruleId: number, nodeId: number): number | null {
  const match = /^(\d+)-(\d+)$/.exec(nodePorts);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!(start >= 1 && end <= 65535 && start <= end)) return null;
  return start + ((ruleId * 31 + nodeId) % (end - start + 1));
}

/**
 * Split a rule target ("host:port", IPv6 bracketed) into host + port.
 * Returns null for anything unparsable — the renderer skips such rules
 * with a warning instead of shipping a broken service.
 */
export function parseTargetAddress(addr: string): RealmTarget | null {
  const idx = addr.lastIndexOf(":");
  if (idx <= 0 || idx === addr.length - 1) return null;
  const host = addr.slice(0, idx).replace(/^\[|\]$/g, "");
  const port = Number(addr.slice(idx + 1));
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const REALM_LISTEN_HOST = "0.0.0.0";
const REALM_CONNECT_TIMEOUT_S = 5;

/** Compose the (host, port) an entry dials for one exit node: the rule's
 * explicit exit_port when pinned, else the deterministic allocation from
 * THAT exit node's port range (both sides agree without coordination). */
function exitTargetFor(rule: RelayRule, exitNode: RelayNode): RealmTarget | null {
  const port = rule.exit_port > 0 ? rule.exit_port : allocatePortForRule(exitNode.ports, rule.id, exitNode.id);
  if (!port) return null;
  return { host: exitNode.address, port };
}

/**
 * Build the RealmNodeConfig for one node — the ONLY config flavor since the
 * realm agent cutover (zero schema change: the flavor lives in
 * node_configs.config_json). Semantics:
 * - every tunnel renders with raw port-pair semantics (forward_mode is
 *   retired; legacy relay rows render identically);
 * - entry node (in link): one service-{ruleId} per rule, listen_port →
 *   exit:exit_port, TLS legs marked tls_side=connect;
 * - exit nodes (out links): one service-{ruleId} per rule on their own
 *   exit_port → rule target, TLS legs marked tls_side=listen;
 * - single-node tunnels (in link only): direct forward to the rule target;
 * - several out links = exit candidate set: primary + extra_targets with a
 *   balance strategy from the in link's strategy column (round→roundrobin);
 *   TLS tunnels stay single-exit (admin validation rejects duplicates);
 * - tunnels with chain (middle-hop) links are skipped — no hop chaining in
 *   the realm data plane;
 * - quota hard-stopped rules drop out via applyRuleQuotas (shared gate with
 *   the legacy pipeline); rule.limit / quota never enter the payload.
 */
export async function buildRealmNodeConfig(db: Database, nodeId: number): Promise<RealmNodeConfig | null> {
  const node = await getNode(db, nodeId);
  if (!node) return null;

  const nodeChains = await getChainsForNode(db, nodeId);
  const tunnelIds = [...new Set(nodeChains.map((c) => c.tunnel_id))];
  const tunnelRows = await getTunnelsByIds(db, tunnelIds);
  const rules = await applyRuleQuotas(db, await getRulesForTunnels(db, tunnelIds));
  const allChains = await getChainsForTunnels(db, tunnelIds);
  const nodeRecs = await getNodesByIds(db, [...new Set(allChains.map((c) => c.node_id))]);
  const nodeById = new Map(nodeRecs.map((n) => [n.id, n]));

  const services: RealmService[] = [];
  let tlsWanted = false;

  for (const tunnel of tunnelRows) {
    const tChains = allChains.filter((c) => c.tunnel_id === tunnel.id);
    if (tChains.some((c) => c.chain_type === ChainType.CHAIN)) {
      console.warn(`[realm-config] tunnel ${tunnel.id}: middle-hop chains are unsupported, tunnel skipped`);
      continue;
    }
    const ins = tChains.filter((c) => c.chain_type === ChainType.IN);
    const outs = tChains.filter((c) => c.chain_type === ChainType.OUT).sort((a, b) => a.index - b.index || a.id - b.id);
    if (ins.length !== 1) {
      console.warn(`[realm-config] tunnel ${tunnel.id}: expected exactly one in link (got ${ins.length}), skipped`);
      continue;
    }
    const isInNode = ins[0].node_id === nodeId;
    const ownOuts = outs.filter((o) => o.node_id === nodeId);
    if (isInNode && ownOuts.length > 0) {
      console.warn(`[realm-config] tunnel ${tunnel.id}: node ${nodeId} holds both ends, unsupported, skipped`);
      continue;
    }
    if (!isInNode && ownOuts.length === 0) continue; // chains reference the node only indirectly

    // TLS link: only the tls transport, only a single exit. Legacy tunnels
    // with other transports (or missing material) degrade to plaintext.
    let tlsLink = false;
    if (tunnel.tls_enabled && outs.length > 0) {
      if (outs[0].transport !== Transport.TLS) {
        console.warn(
          `[realm-config] tunnel ${tunnel.id}: tls_enabled with transport '${outs[0].transport}' degrades to plaintext (realm speaks tls only)`,
        );
      } else {
        if (outs.length > 1) {
          console.warn(`[realm-config] tunnel ${tunnel.id}: TLS tunnels stay single-exit, using the first out link`);
        }
        tlsLink = true;
      }
    }

    const tunnelRules = rules.filter((r) => r.tunnel_id === tunnel.id);

    if (isInNode) {
      const exits = tlsLink ? outs.slice(0, 1) : outs;
      const balance = ins[0].strategy === "iphash" ? "iphash" : "roundrobin";
      for (const rule of tunnelRules) {
        const service: RealmService = {
          name: `service-${rule.id}`,
          listen_host: REALM_LISTEN_HOST,
          listen_port: rule.listen_port,
          target_host: "",
          target_port: 0,
          connect_timeout_s: REALM_CONNECT_TIMEOUT_S,
        };
        if (tlsLink) {
          service.tls_side = "connect";
          tlsWanted = true;
        }
        if (exits.length === 0) {
          const target = parseTargetAddress(rule.targets);
          if (!target) {
            console.warn(`[realm-config] rule ${rule.id}: unparsable target '${rule.targets}', skipped`);
            continue;
          }
          service.target_host = target.host;
          service.target_port = target.port;
        } else {
          const primary = exitTargetFor(rule, nodeById.get(exits[0].node_id) ?? node);
          if (!primary) {
            console.warn(`[realm-config] rule ${rule.id}: exit port allocation failed, skipped`);
            continue;
          }
          service.target_host = primary.host;
          service.target_port = primary.port;
          const extras: RealmTarget[] = [];
          for (const out of exits.slice(1)) {
            const extra = exitTargetFor(rule, nodeById.get(out.node_id) ?? node);
            if (extra) extras.push(extra);
          }
          if (extras.length > 0) {
            service.extra_targets = extras;
            service.balance = balance;
          }
        }
        services.push(service);
      }
    }

    for (const rule of tunnelRules) {
      const target = parseTargetAddress(rule.targets);
      if (!target) {
        console.warn(`[realm-config] rule ${rule.id}: unparsable target '${rule.targets}', skipped`);
        continue;
      }
      const exitPort = rule.exit_port > 0 ? rule.exit_port : allocatePortForRule(node.ports, rule.id, node.id);
      if (!exitPort) {
        console.warn(`[realm-config] rule ${rule.id}: exit port allocation failed, skipped`);
        continue;
      }
      const service: RealmService = {
        name: `service-${rule.id}`,
        listen_host: REALM_LISTEN_HOST,
        listen_port: exitPort,
        target_host: target.host,
        target_port: target.port,
        connect_timeout_s: REALM_CONNECT_TIMEOUT_S,
      };
      if (tlsLink) {
        service.tls_side = "listen";
        tlsWanted = true;
      }
      services.push(service);
    }
  }

  // Stable order for deterministic snapshots (version-bump diffing) — sort by
  // name then port; same-name services (entry+exit on different nodes never
  // collide here since each node renders only its own).
  services.sort((a, b) => a.name.localeCompare(b.name) || a.listen_port - b.listen_port);
  const seen = new Set<string>();
  for (const s of services) {
    const key = `${s.listen_host}:${s.listen_port}`;
    if (seen.has(key)) {
      console.warn(`[realm-config] node ${nodeId}: port ${s.listen_port} shared by services (${s.name})`);
    }
    seen.add(key);
  }

  const config: RealmNodeConfig = { agent: "realm", node: { id: node.id, name: node.name }, services };
  if (tlsWanted) {
    try {
      config.tls_material = await ensureTlsMaterial(db);
    } catch (err) {
      // No TLS domain configured (or generation failed): degrade BOTH legs to
      // plaintext — the exit renders the same way from the same flags.
      console.warn(`[realm-config] node ${nodeId}: TLS material unavailable, degrading links to plaintext`, err);
      for (const s of services) delete s.tls_side;
    }
  }
  return config;
}

export interface RecomputeResult {
  /** false when the node does not exist (snapshot deleted). */
  ok: boolean;
  /** false when the recomputed content is identical — version is NOT bumped. */
  changed: boolean;
}

/**
 * Recompute and persist the config snapshot for a node. An unchanged config
 * skips the version bump entirely, so periodic sweeps (daily cron) cannot
 * force every agent into a pointless full refetch.
 */
export async function recomputeNodeConfig(db: Database, nodeId: number): Promise<RecomputeResult> {
  const config = await buildRealmNodeConfig(db, nodeId);
  const now = new Date().toISOString();
  if (!config) {
    await deleteNodeConfigSnapshot(db, nodeId);
    return { ok: false, changed: false };
  }
  const configJson = JSON.stringify(config);
  const prev = await getNodeConfigSnapshot(db, nodeId);
  if (prev && prev.configJson === configJson) {
    return { ok: true, changed: false };
  }
  await upsertNodeConfigSnapshot(db, nodeId, configJson, now);
  return { ok: true, changed: true };
}

// (end of renderer — the legacy NodeConfigData aggregation was removed with
// the Go agent cutover; see git history for the gost-era pipeline)
