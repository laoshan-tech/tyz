import { RelayRuleStatus, type ServiceHealthSample } from "@tyz/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db";
import { relayRules, serviceHealth } from "../db/schema";
import { nodeRuleTunnels } from "./traffic";

/**
 * Heartbeat ingest: node liveness + the full service-state snapshot.
 *
 * Node liveness lives in a SENTINEL row of service_health (`__heartbeat__`,
 * state `ready`) — one upsert per heartbeat stamps `reported_at` without any
 * schema change. The name can never collide with real services (`service-{id}`
 * / `service-t{id}`), the rule-status regex ignores it, and read paths filter
 * it out — the web never sees it.
 *
 * The snapshot rides the same request by design: it is idempotent full state,
 * not cumulative counters, so it belongs on the periodic liveness channel, not
 * the event-driven traffic channel. An EMPTY snapshot is meaningful — it clears
 * every service row for the node (world emptied / quota hard-stop).
 *
 * Callers: the NodePushDO's WS heartbeat message and POST /api/agent/heartbeat.
 * The legacy /stats health branch is gone (agents and server upgrade together).
 */

export const HEARTBEAT_SERVICE = "__heartbeat__";

/** A node whose latest report is older than this renders as 离线 (dashboard derives it server-side). */
export const OFFLINE_AFTER_MS = 5 * 60_000;

/** D1 caps bound parameters per statement; health rows bind 5 params, IN lists stay under 100. */
function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function ingestHealthSnapshot(
  db: Database,
  nodeId: number,
  health: ServiceHealthSample[],
  reportedAt: string,
): Promise<void> {
  // Liveness stamp first: even a snapshot-less beat proves the node is alive.
  await db
    .insert(serviceHealth)
    .values({ node_id: nodeId, service: HEARTBEAT_SERVICE, state: "ready", error: null, reported_at: reportedAt })
    .onConflictDoUpdate({
      target: [serviceHealth.node_id, serviceHealth.service],
      set: {
        state: sql`excluded.state`,
        error: sql`excluded.error`,
        reported_at: sql`excluded.reported_at`,
      },
    });

  if (health.length > 0) {
    const healthRows = health.map((h) => ({
      node_id: nodeId,
      service: h.service,
      state: h.state,
      error: h.error ?? null,
      reported_at: reportedAt,
    }));
    for (const part of chunk(healthRows, 16)) {
      await db
        .insert(serviceHealth)
        .values(part)
        .onConflictDoUpdate({
          target: [serviceHealth.node_id, serviceHealth.service],
          set: {
            state: sql`excluded.state`,
            error: sql`excluded.error`,
            reported_at: sql`excluded.reported_at`,
          },
        });
    }
  }

  // Drop rows for services no longer present. The delete runs on EVERY beat
  // (not only non-empty snapshots): an empty snapshot is the only signal that
  // the node's world emptied. NOT IN must NOT be chunked — each chunk's
  // statement would delete the other chunks' freshly upserted rows. Diff the
  // reported snapshot against the stored set and delete the complement via
  // chunked IN lists instead (IN chunks are union semantics); the sentinel is
  // always "reported" so it survives.
  const reported = new Set([HEARTBEAT_SERVICE, ...health.map((h) => h.service)]);
  const existing = await db
    .select({ service: serviceHealth.service })
    .from(serviceHealth)
    .where(eq(serviceHealth.node_id, nodeId));
  const stale = existing.map((row) => row.service).filter((service) => !reported.has(service));
  for (const part of chunk(stale, 90)) {
    await db.delete(serviceHealth).where(and(eq(serviceHealth.node_id, nodeId), inArray(serviceHealth.service, part)));
  }

  if (health.length === 0) return;

  // Derive rule runtime status from the entry-service snapshot: status is a
  // display label (deployment follows config, not status), so only positive
  // evidence writes back — healthy entry service → running, failed/apply_failed
  // → error. `paused` is the operator's manual state and is never overwritten;
  // rules whose service is absent from the snapshot keep their status. The
  // service string is attacker-controlled, so a status write additionally
  // requires the node to participate in the rule's tunnel (nodeRuleTunnels).
  const ruleStatus = new Map<number, RelayRuleStatus>();
  for (const h of health) {
    const match = /^service-(\d+)$/.exec(h.service);
    if (match === null) continue; // service-t{id} exit relays are shared across a tunnel's rules
    if (h.state === "ready" || h.state === "running") ruleStatus.set(Number(match[1]), RelayRuleStatus.RUNNING);
    else if (h.state === "failed" || h.state === "apply_failed") {
      ruleStatus.set(Number(match[1]), RelayRuleStatus.ERROR);
    }
  }
  if (ruleStatus.size === 0) return;

  // One chunked SELECT doubles as authorization (rule's tunnel ∈ the node's
  // per-rule tunnels) and change detection (steady state = zero UPDATE
  // statements per beat). Chunking is not optional: >100 distinct rule
  // services in a snapshot would exceed D1's bound-parameter cap and 500 the
  // whole upload (TYZ-004 class).
  const ruleTunnels = await nodeRuleTunnels(db, nodeId);
  const ids = [...ruleStatus.keys()];
  const current = new Map<number, RelayRuleStatus>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db
      .select({ id: relayRules.id, tunnel_id: relayRules.tunnel_id, status: relayRules.status })
      .from(relayRules)
      .where(inArray(relayRules.id, ids.slice(i, i + 90)));
    for (const r of rows) {
      if (r.tunnel_id !== null && ruleTunnels.has(r.tunnel_id)) current.set(r.id, r.status);
    }
  }
  for (const [ruleId, status] of ruleStatus) {
    const cur = current.get(ruleId);
    // undefined = not the node's rule (authorization failed); equal = no change.
    if (cur === undefined || cur === status) continue;
    await db
      .update(relayRules)
      .set({ status, updated_at: reportedAt })
      .where(
        and(eq(relayRules.id, ruleId), ne(relayRules.status, RelayRuleStatus.PAUSED), ne(relayRules.status, status)),
      );
  }
}
