import { ChainType, type GostStatsSample } from "@tyz/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { chains, relayNodes, relayRules, serviceMetricsHourly, trafficCounters, trafficHourly } from "../db/schema";

/** Chunk under D1's 100 bound parameters per statement (see routes/agent.ts). */
function chunk<T>(rows: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < rows.length; i += size) parts.push(rows.slice(i, i + size));
  return parts;
}

/**
 * Tunnels on which the node deploys per-rule services (service-{ruleId}):
 * every IN-chain node (entries) and every OUT-chain node (exits). The realm
 * agent renders per-rule port pairs on BOTH ends of every tunnel (raw
 * semantics — the legacy relay forward_mode is retired), so multi-leg usage
 * is INTENTIONALLY the sum over every node serving the rule; operators trim
 * legs via each node's rate (0 = record but don't bill). Used as the
 * billing/status authorization set.
 */
export async function nodeRuleTunnels(db: Database, nodeId: number): Promise<Set<number>> {
  const nodeChains = await db
    .select({ tunnel_id: chains.tunnel_id, chain_type: chains.chain_type })
    .from(chains)
    .where(eq(chains.node_id, nodeId));
  const ruleTunnels = new Set<number>();
  for (const c of nodeChains) {
    if (c.chain_type === ChainType.IN || c.chain_type === ChainType.OUT) ruleTunnels.add(c.tunnel_id);
  }
  return ruleTunnels;
}

/**
 * Hourly traffic ledger ingest.
 *
 * gost_stats rows (and the observer samples behind them) carry CUMULATIVE
 * per-service counters; the ledger needs deltas. `traffic_counters` keeps the
 * last cumulative value per (node, service) and every sample contributes
 * `cur - last`; a counter reset (service recreated by a config change) shows
 * up as `cur < last` and contributes `cur` itself. Samples are processed in
 * arrival order — the agent buffers up to a flush-interval worth of 5s-period
 * observer reports, so several consecutive snapshots of one service in a
 * single batch are normal and must chain.
 *
 * Writes go ledger-first, counters-second: a crash between the two re-deltas
 * from the OLD counter on the next report, double-counting at most one
 * report interval — the safe direction for a billing ledger (over, never
 * under). Same-node reports are serialized by the agent's flush lock, so the
 * read-modify-write has no practical race.
 */

/** '2026-08-16T04:38:23.486Z' -> '2026-08-16T04:00:00.000Z' (the hour key). */
export function hourFloorIso(iso: string): string {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

interface HourBucket {
  ruleId: number;
  userId: number;
  hourTs: string;
  upload: number;
  download: number;
}

/**
 * Fold one node's stats samples into the hourly ledger (best effort), plus the
 * observation counters on relay_nodes/relay_rules (display-only, resettable —
 * see POST /rules/:id/reset-traffic). Multi-node rule usage is the SUM over
 * every node serving the rule: raw-mode exits report under the same
 * service-{ruleId} name as the entry.
 *
 * Returns the distinct rule ids that received a billed delta this batch
 * (authorization-gated, service-level rows only) — the input of the
 * flush-driven quota sweep (quotaSweepStoppedUsers).
 */
export async function ingestTraffic(
  db: Database,
  nodeId: number,
  samples: GostStatsSample[],
  /** Pre-fetched per-rule tunnels (nodeRuleTunnels) — the stats route shares one lookup with its status gate. */
  nodeTunnels?: Set<number>,
): Promise<number[]> {
  const serviceSamples = samples.filter((s) => !s.client);
  await rollupServiceMetrics(db, nodeId, serviceSamples);
  if (serviceSamples.length === 0) return [];

  // Service-level rows only; per-client rows are breakdowns of the same
  // traffic. Shared exit listeners (service-t{tunnelId}) do not parse as rule
  // ids and are excluded from the RULE ledger/buckets — they still count
  // toward the node's own totals.
  // TODO(billing): relay-mode exit legs cannot be attributed per rule — the
  // shared listener multiplexes a tunnel's rules over one port and the observer
  // sample carries no in-band destination, so only the entry leg reaches the
  // rule ledger. Multi-leg usage is therefore under-counted on relay tunnels
  // relative to the "every serving node's leg counts, trimmed by per-node rate"
  // model (raw tunnels attribute both legs). Fix directions to evaluate:
  // per-connection destination capture at the relay exit (agent-side handler
  // hook emitting synthetic per-rule samples), or billing the exit leg at
  // tunnel granularity from service-t totals.
  const isRuleService = (name: string) => /^service-(\d+)$/.test(name) && Number(name.slice(8)) > 0;

  // Deltas are computed for EVERY service (shared exits included): the node
  // totals need them, which is also why traffic_counters now tracks
  // service-t* rows. The IN lists are chunked: D1 caps bound parameters per
  // statement (100) and a busy node's batch can reference many services.
  const names = [...new Set(serviceSamples.map((s) => s.service))];
  const last = new Map<string, { upload: number; download: number }>();
  for (let i = 0; i < names.length; i += 90) {
    const part = names.slice(i, i + 90);
    const rows = await db
      .select()
      .from(trafficCounters)
      .where(and(eq(trafficCounters.node_id, nodeId), inArray(trafficCounters.service, part)));
    for (const c of rows) last.set(c.service, { upload: c.upload, download: c.download });
  }

  const ruleIds = [
    ...new Set(serviceSamples.filter((s) => isRuleService(s.service)).map((s) => Number(s.service.slice(8)))),
  ];
  // Billing authorization: the service string is attacker-controlled (any node
  // token holder can POST arbitrary names), and a forged service-{ruleId} would
  // bill ANY tenant's ledger — draining their quota until the sweep hard-stops
  // their rules everywhere. A sample may only enter the rule ledger when the
  // reporting node actually deploys that rule's service (see nodeRuleTunnels);
  // foreign services still count toward the node's own totals, which is the
  // documented self-reporting trust boundary.
  const ruleTunnels = nodeTunnels ?? (await nodeRuleTunnels(db, nodeId));
  const ownerOf = new Map<number, number>();
  for (let i = 0; i < ruleIds.length; i += 90) {
    const part = ruleIds.slice(i, i + 90);
    const rows = await db
      .select({ id: relayRules.id, user_id: relayRules.user_id, tunnel_id: relayRules.tunnel_id })
      .from(relayRules)
      .where(inArray(relayRules.id, part));
    for (const r of rows) {
      if (r.tunnel_id !== null && ruleTunnels.has(r.tunnel_id)) ownerOf.set(r.id, r.user_id ?? 0);
    }
  }

  const now = new Date().toISOString();
  const hourTs = hourFloorIso(now);
  const buckets = new Map<number, HourBucket>(); // key: ruleId (single hour per batch)
  const counterUpdates = new Map<string, { upload: number; download: number }>();
  let nodeIngress = 0;
  let nodeEgress = 0;

  for (const s of serviceSamples) {
    const prev = last.get(s.service);
    let dUp = s.inputBytes;
    let dDown = s.outputBytes;
    if (prev && s.inputBytes >= prev.upload && s.outputBytes >= prev.download) {
      dUp = s.inputBytes - prev.upload;
      dDown = s.outputBytes - prev.download;
    }
    // else: counter reset (or first sighting) — the whole current value is
    // this interval's traffic.
    last.set(s.service, { upload: s.inputBytes, download: s.outputBytes });
    counterUpdates.set(s.service, { upload: s.inputBytes, download: s.outputBytes });

    nodeIngress += dUp;
    nodeEgress += dDown;

    if (!isRuleService(s.service)) continue;
    if (dUp <= 0 && dDown <= 0) continue;
    const ruleId = Number(s.service.slice(8));
    // Foreign rule (node does not serve this rule's tunnel): the sample fed
    // the node's own totals above and stops here — never the victim's ledger.
    if (!ownerOf.has(ruleId)) continue;
    const bucket = buckets.get(ruleId) ?? {
      ruleId,
      userId: ownerOf.get(ruleId) ?? 0,
      hourTs,
      upload: 0,
      download: 0,
    };
    bucket.upload += dUp;
    bucket.download += dDown;
    buckets.set(ruleId, bucket);
  }

  // Ledger first (see the file comment for the crash-ordering rationale) —
  // billing stays authoritative; the observation columns below are best
  // effort and a crash between the two only loses display bytes.
  // All multi-row upserts are chunked under D1's 100 bound parameters per
  // statement (traffic_hourly rows bind 8, traffic_counters 5); the Maps are
  // key-deduped, so no statement repeats a conflict target.
  if (buckets.size > 0) {
    // The node's billing rate: charged bytes = round(real x rate).
    const node = await db.select({ rate: relayNodes.rate }).from(relayNodes).where(eq(relayNodes.id, nodeId)).get();
    const rate = node?.rate ?? 1.0;
    const hourlyRows = [...buckets.values()].map((b) => ({
      rule_id: b.ruleId,
      user_id: b.userId,
      node_id: nodeId,
      hour_ts: b.hourTs,
      real_upload: b.upload,
      real_download: b.download,
      billed_upload: Math.round(b.upload * rate),
      billed_download: Math.round(b.download * rate),
    }));
    for (const part of chunk(hourlyRows, 12)) {
      await db
        .insert(trafficHourly)
        .values(part)
        .onConflictDoUpdate({
          target: [trafficHourly.rule_id, trafficHourly.hour_ts],
          set: {
            real_upload: sql`${trafficHourly.real_upload} + excluded.real_upload`,
            real_download: sql`${trafficHourly.real_download} + excluded.real_download`,
            billed_upload: sql`${trafficHourly.billed_upload} + excluded.billed_upload`,
            billed_download: sql`${trafficHourly.billed_download} + excluded.billed_download`,
          },
        });
    }
  }
  const counterRows = [...counterUpdates].map(([service, c]) => ({
    node_id: nodeId,
    service,
    upload: c.upload,
    download: c.download,
    updated_at: now,
  }));
  for (const part of chunk(counterRows, 16)) {
    await db
      .insert(trafficCounters)
      .values(part)
      .onConflictDoUpdate({
        target: [trafficCounters.node_id, trafficCounters.service],
        set: { upload: sql`excluded.upload`, download: sql`excluded.download`, updated_at: sql`excluded.updated_at` },
      });
  }

  // Observation counters: per-rule (sums every node's leg) and per-node (all
  // services, shared exits included). Plain increments — resettable without
  // touching the ledger above. Per-rule deltas differ, so they ride a CASE over
  // the chunk's ids: one UPDATE per chunk instead of per rule (5 params/rule,
  // and the UPDATE no-ops rows that vanished — unlike an upsert, which would
  // resurrect a deleted rule).
  for (const part of chunk([...buckets.values()], 16)) {
    const upCase = sql.join(
      part.map((b) => sql`WHEN ${b.ruleId} THEN ${b.upload}`),
      sql` `,
    );
    const downCase = sql.join(
      part.map((b) => sql`WHEN ${b.ruleId} THEN ${b.download}`),
      sql` `,
    );
    await db
      .update(relayRules)
      .set({
        upload_traffic: sql`${relayRules.upload_traffic} + CASE ${relayRules.id} ${upCase} ELSE 0 END`,
        download_traffic: sql`${relayRules.download_traffic} + CASE ${relayRules.id} ${downCase} ELSE 0 END`,
      })
      .where(
        inArray(
          relayRules.id,
          part.map((b) => b.ruleId),
        ),
      );
  }
  if (nodeIngress > 0 || nodeEgress > 0) {
    await db
      .update(relayNodes)
      .set({
        ingress_traffic: sql`${relayNodes.ingress_traffic} + ${nodeIngress}`,
        egress_traffic: sql`${relayNodes.egress_traffic} + ${nodeEgress}`,
      })
      .where(eq(relayNodes.id, nodeId));
  }

  return [...buckets.keys()];
}

/**
 * Hourly per-service connection rollup (B6): samples + sum (exact average at
 * read time) and max (peaks cause stalls; an average flattens them). Covers
 * every service-level sample, including shared exit listeners (service-t*).
 */
async function rollupServiceMetrics(db: Database, nodeId: number, serviceSamples: GostStatsSample[]): Promise<void> {
  if (serviceSamples.length === 0) return;
  const hourTs = hourFloorIso(new Date().toISOString());
  const agg = new Map<string, { samples: number; connSum: number; connMax: number }>();
  for (const s of serviceSamples) {
    const cur = agg.get(s.service) ?? { samples: 0, connSum: 0, connMax: 0 };
    cur.samples += 1;
    cur.connSum += s.currentConns;
    cur.connMax = Math.max(cur.connMax, s.currentConns);
    agg.set(s.service, cur);
  }
  // 6 bound params per row — 16 per statement stays under D1's 100 cap.
  for (const part of chunk(
    [...agg.entries()].map(([service, m]) => ({ service, m })),
    16,
  )) {
    await db
      .insert(serviceMetricsHourly)
      .values(
        part.map(({ service, m }) => ({
          node_id: nodeId,
          service,
          hour_ts: hourTs,
          samples: m.samples,
          conn_sum: m.connSum,
          conn_max: m.connMax,
        })),
      )
      .onConflictDoUpdate({
        target: [serviceMetricsHourly.node_id, serviceMetricsHourly.service, serviceMetricsHourly.hour_ts],
        set: {
          samples: sql`${serviceMetricsHourly.samples} + excluded.samples`,
          conn_sum: sql`${serviceMetricsHourly.conn_sum} + excluded.conn_sum`,
          conn_max: sql`MAX(${serviceMetricsHourly.conn_max}, excluded.conn_max)`,
        },
      });
  }
}
