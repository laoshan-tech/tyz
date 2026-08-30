import { eq } from "drizzle-orm";
import { createDb } from "../db";
import { recomputeNodeConfig } from "../db/repo";
import { chains, relayRules } from "../db/schema";
import type { Bindings } from "../env";
import { notifyConfigChanged } from "./notify";

/** Recompute one node's snapshot and push a change notification to its agent. */
export async function recomputeAndNotify(env: Bindings, nodeId: number): Promise<boolean> {
  const res = await recomputeNodeConfig(createDb(env.DB), nodeId);
  if (res.changed) {
    await notifyConfigChanged(env, [nodeId]);
  }
  return res.ok;
}

/**
 * Recompute config snapshots for every node that has a chain in the tunnel, then notify them.
 * Node aggregations are independent, so they run in PARALLEL — wall time stays
 * ~one node's recompute regardless of fleet size (each aggregation is 10-15
 * sequential D1 roundtrips; a serial loop made admin writes scale with O(nodes)).
 * A single node's failure is logged and skipped, never failing the admin write:
 * the daily cron's full recompute self-heals it.
 */
export async function recomputeTunnelNodes(env: Bindings, tunnelId: number): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db.selectDistinct({ node_id: chains.node_id }).from(chains).where(eq(chains.tunnel_id, tunnelId));
  const results = await Promise.allSettled(rows.map(({ node_id }) => recomputeNodeConfig(db, node_id)));
  const changed: number[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value.changed) changed.push(rows[i].node_id);
    } else {
      console.error(`recompute node ${rows[i].node_id} (tunnel ${tunnelId}) failed`, result.reason);
    }
  });
  if (changed.length > 0) {
    await notifyConfigChanged(env, changed);
  }
}

/** Recompute every node serving one user's rules (ownership/quota changes). */
export async function recomputeUserNodes(env: Bindings, userId: number): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db
    .selectDistinct({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.user_id, userId));
  await Promise.all(
    rows.map(({ tunnel_id }) => (tunnel_id !== null ? recomputeTunnelNodes(env, tunnel_id) : undefined)),
  );
}
