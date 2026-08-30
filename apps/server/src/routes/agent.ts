import { agentStatsBatchSchema, RelayRuleStatus } from "@tyz/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createDb } from "../db";
import { getNodeConfigSnapshot, recomputeNodeConfig } from "../db/repo";
import { gostStats, relayRules, serviceHealth } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { nodeAuth } from "../middleware/nodeAuth";
import { quotaSweepStoppedUsers } from "../services/quota";
import { recomputeUserNodes } from "../services/recompute";
import { ingestTraffic, nodeRuleTunnels } from "../services/traffic";

export const agentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

agentRoutes.use("*", nodeAuth());

/**
 * Poll endpoint: GET /api/agent/config?version=N
 * Returns 304 when the node's config version has not advanced past N,
 * otherwise 200 with { version, config }.
 */
agentRoutes.get("/config", async (c) => {
  const rawVersion = c.req.query("version");
  let currentVersion = 0;
  if (rawVersion !== undefined) {
    currentVersion = Number.parseInt(rawVersion, 10);
    if (Number.isNaN(currentVersion) || currentVersion < 0) {
      return c.json({ error: "version must be a non-negative integer" }, 400);
    }
  }

  const nodeId = c.get("node").id;
  const db = createDb(c.env.DB);

  let snapshot = await getNodeConfigSnapshot(db, nodeId);
  if (!snapshot) {
    // A node created before any config was materialized: aggregate on demand.
    await recomputeNodeConfig(db, nodeId);
    snapshot = await getNodeConfigSnapshot(db, nodeId);
  }
  if (!snapshot) {
    return c.json({ error: "node not found" }, 404);
  }

  if (snapshot.version <= currentVersion) {
    return c.body(null, 304);
  }
  return c.json({ version: snapshot.version, config: JSON.parse(snapshot.configJson) });
});

/**
 * WebSocket push channel: GET /api/agent/ws (Upgrade: websocket)
 * Authenticated like every /api/agent route; the upgrade request is forwarded to
 * this node's NodePushDO, which keeps the connection and broadcasts
 * {"type":"config_changed"} whenever an admin write recomputes the node.
 */
agentRoutes.get("/ws", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }
  const nodeId = c.get("node").id;
  const stub = c.env.CONFIG_PUSH.get(c.env.CONFIG_PUSH.idFromName(String(nodeId)));
  return stub.fetch(c.req.raw);
});

/**
 * D1 caps bound parameters per statement (100). The observer reports per
 * (service × client), so one flush can easily carry dozens of samples — a
 * single multi-row insert then exceeds the cap and throws, which (pre-fix)
 * permanently wedged the agent's whole-buffer retry. Chunk every batched
 * write back to a fixed row count per statement: stats rows bind 4 params,
 * health rows 5, so 20/16 rows stay under 100.
 */
function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Flush-driven quota hard-stop (the R4 mitigation — see
 * services/quota.ts::quotaSweepStoppedUsers): the realm payload carries no
 * in-agent quota gate, so exhaustion enforcement is config removal. Runs AFTER
 * the response (waitUntil, mirroring admin's deferRecompute); failures are
 * logged and self-heal — the next flush retries while the rules are still
 * deployed, and the daily cron remains the backstop.
 */
function scheduleQuotaSweep(c: Context<{ Bindings: Bindings; Variables: Variables }>, billedRuleIds: number[]): void {
  if (billedRuleIds.length === 0) return;
  c.executionCtx.waitUntil(
    (async () => {
      const users = await quotaSweepStoppedUsers(createDb(c.env.DB), billedRuleIds);
      await Promise.all(users.map((userId) => recomputeUserNodes(c.env, userId)));
    })().catch((err) => console.error("quota sweep failed", err)),
  );
}

/** Batched stats upload from agents (samples and/or service health snapshot). */
agentRoutes.post("/stats", async (c) => {
  const parsed = agentStatsBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid stats payload", detail: parsed.error.flatten() }, 400);
  }

  const nodeId = c.get("node").id;
  const reportedAt = new Date().toISOString();
  const db = createDb(c.env.DB);

  // Per-rule service authorization (see nodeRuleTunnels), shared by the billing
  // gate (ingestTraffic) and the status-write gate below — computed once per
  // report; two indexed lookups (node chains + raw-mode out tunnels).
  const ruleTunnels = await nodeRuleTunnels(db, nodeId);

  if (parsed.data.samples.length > 0) {
    const sampleRows = parsed.data.samples.map((sample) => ({
      node_id: nodeId,
      service: sample.service,
      stats: sample,
      reported_at: reportedAt,
    }));
    for (const part of chunk(sampleRows, 20)) {
      await db.insert(gostStats).values(part);
    }
    // Fold the samples into the hourly ledger (billing source of truth).
    // Best effort: a failed ingest must not fail the stats upload (the sweep
    // is skipped for that batch; the next flush covers it).
    let billedRuleIds: number[] = [];
    await ingestTraffic(db, nodeId, parsed.data.samples, ruleTunnels)
      .then((ruleIds) => {
        billedRuleIds = ruleIds;
      })
      .catch((err) => console.error("traffic ledger ingest failed", err));
    scheduleQuotaSweep(c, billedRuleIds);
  }

  // The health array is a full snapshot of the node's services: upsert every
  // entry and drop rows for services no longer present (config removals).
  if (parsed.data.health.length > 0) {
    const healthRows = parsed.data.health.map((h) => ({
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
    // Drop rows for services no longer present (config removals). NOT IN must
    // NOT be chunked — each chunk's statement would delete the other chunks'
    // freshly upserted rows (>90 services wiped the whole node's health). Diff
    // the reported snapshot against the stored set and delete the complement
    // via chunked IN lists instead (IN chunks are union semantics).
    const reported = new Set(healthRows.map((h) => h.service));
    const existing = await db
      .select({ service: serviceHealth.service })
      .from(serviceHealth)
      .where(eq(serviceHealth.node_id, nodeId));
    const stale = existing.map((row) => row.service).filter((service) => !reported.has(service));
    for (const part of chunk(stale, 90)) {
      await db
        .delete(serviceHealth)
        .where(and(eq(serviceHealth.node_id, nodeId), inArray(serviceHealth.service, part)));
    }

    // Derive rule runtime status from the entry-service snapshot: status is a
    // display label (deployment follows config, not status), so only positive
    // evidence writes back — healthy entry service → running, failed/apply_failed
    // → error. `paused` is the operator's manual state and is never overwritten;
    // rules whose service is absent from the snapshot (fresh, or dropped by the
    // quota hard-stop) keep their current status. The service string is
    // attacker-controlled, so a status write additionally requires the node to
    // participate in the rule's tunnel (see the same gate in ingestTraffic).
    const ruleStatus = new Map<number, RelayRuleStatus>();
    for (const h of parsed.data.health) {
      const match = /^service-(\d+)$/.exec(h.service);
      if (match === null) continue; // service-t{id} exit relays are shared across a tunnel's rules
      if (h.state === "ready" || h.state === "running") ruleStatus.set(Number(match[1]), RelayRuleStatus.RUNNING);
      else if (h.state === "failed" || h.state === "apply_failed") {
        ruleStatus.set(Number(match[1]), RelayRuleStatus.ERROR);
      }
    }
    if (ruleStatus.size > 0) {
      // One chunked SELECT doubles as authorization (rule's tunnel ∈ the node's
      // per-rule tunnels) and change detection (steady state = zero UPDATE
      // statements per flush). Chunking is not optional: >100 distinct rule
      // services in a snapshot would exceed D1's bound-parameter cap and 500
      // the whole upload — re-wedging the agent's retry loop (TYZ-004 class).
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
            and(
              eq(relayRules.id, ruleId),
              ne(relayRules.status, RelayRuleStatus.PAUSED),
              ne(relayRules.status, status),
            ),
          );
      }
    }
  }

  return c.json({ ok: true, inserted: parsed.data.samples.length });
});
