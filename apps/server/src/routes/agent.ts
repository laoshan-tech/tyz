import { agentHeartbeatSchema, agentStatsBatchSchema } from "@tyz/shared";
import { type Context, Hono } from "hono";
import { createDb } from "../db";
import { getNodeConfigSnapshot, recomputeNodeConfig } from "../db/repo";
import { gostStats } from "../db/schema";
import type { Bindings, Variables } from "../env";
import { nodeAuth } from "../middleware/nodeAuth";
import { ingestHealthSnapshot } from "../services/health";
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
 * so 20 rows stay under 100.
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

/** Batched traffic-sample upload from agents. Service health rides the
 * heartbeat channel instead (services/health.ts) — see POST /heartbeat. */
agentRoutes.post("/stats", async (c) => {
  const parsed = agentStatsBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid stats payload", detail: parsed.error.flatten() }, 400);
  }

  const nodeId = c.get("node").id;
  const reportedAt = new Date().toISOString();
  const db = createDb(c.env.DB);

  // Per-rule service authorization for the billing gate (see nodeRuleTunnels):
  // two indexed lookups (node chains + raw-mode out tunnels).
  const ruleTunnels = await nodeRuleTunnels(db, nodeId);

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

  return c.json({ ok: true, inserted: parsed.data.samples.length });
});

/**
 * Heartbeat: node liveness + the full service-state snapshot, one POST per
 * HEARTBEAT_INTERVAL when the WS channel is down (the healthy path delivers
 * the same payload over the node's WebSocket — see do/nodePush.ts). The empty
 * snapshot is valid and clears the node's stale service rows.
 */
agentRoutes.post("/heartbeat", async (c) => {
  const parsed = agentHeartbeatSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid heartbeat payload", detail: parsed.error.flatten() }, 400);
  }
  const nodeId = c.get("node").id;
  await ingestHealthSnapshot(createDb(c.env.DB), nodeId, parsed.data.health, new Date().toISOString());
  return c.json({ ok: true });
});
