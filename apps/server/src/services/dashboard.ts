import type { DashboardSummary, DashboardTrafficPoint } from "@tyz/shared";
import { and, count, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../db";
import {
  relayNodes,
  relayRules,
  serviceHealth,
  serviceMetricsHourly,
  trafficHourly,
  tunnels,
  userPackages,
  users,
} from "../db/schema";
import { HEARTBEAT_SERVICE, OFFLINE_AFTER_MS } from "./health";
import { quotaDecisionsForUsers } from "./quota";
import { hourFloorIso } from "./traffic";

/**
 * Dashboard read-only aggregations (no audit rows, no secrets). Everything
 * here is derived from tables the admin API already exposes piecewise; the
 * summary exists so the panel's front page costs one request instead of
 * N lists + per-node health polls.
 */

interface DayTraffic {
  upload: number;
  download: number;
}

async function trafficForDay(db: Database, fromIso: string, toIso: string): Promise<DayTraffic> {
  const [row] = await db
    .select({
      upload: sql<number>`COALESCE(SUM(${trafficHourly.billed_upload}), 0)`,
      download: sql<number>`COALESCE(SUM(${trafficHourly.billed_download}), 0)`,
    })
    .from(trafficHourly)
    .where(and(gte(trafficHourly.hour_ts, fromIso), lt(trafficHourly.hour_ts, toIso)));
  // SUM over integers comes back as string | number depending on the driver; normalize.
  return { upload: Number(row?.upload ?? 0), download: Number(row?.download ?? 0) };
}

function dayStartIso(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export async function dashboardSummary(db: Database): Promise<DashboardSummary> {
  const [nodeRows, tunnelRows, ruleRows, userRows, subRows, healthRows, seenRows, peakRows] = await Promise.all([
    db.select({ id: relayNodes.id, name: relayNodes.name }).from(relayNodes).orderBy(relayNodes.id),
    db.select({ n: count() }).from(tunnels),
    db.select().from(relayRules),
    db.select({ status: users.status, n: count() }).from(users).groupBy(users.status),
    db.select({ n: count() }).from(userPackages),
    // Service-state counts EXCLUDE the heartbeat sentinel; liveness comes from
    // the sentinel rows below (one per node, always the freshest row).
    db
      .select({
        node_id: serviceHealth.node_id,
        state: serviceHealth.state,
        n: count(),
        last: sql<string | null>`MAX(${serviceHealth.reported_at})`,
      })
      .from(serviceHealth)
      .where(ne(serviceHealth.service, HEARTBEAT_SERVICE))
      .groupBy(serviceHealth.node_id, serviceHealth.state),
    db
      .select({ node_id: serviceHealth.node_id, seen_at: serviceHealth.reported_at })
      .from(serviceHealth)
      .where(eq(serviceHealth.service, HEARTBEAT_SERVICE)),
    db
      .select({ node_id: serviceMetricsHourly.node_id, peak: sql<number>`MAX(${serviceMetricsHourly.conn_max})` })
      .from(serviceMetricsHourly)
      .where(gte(serviceMetricsHourly.hour_ts, hourFloorIso(new Date(Date.now() - 24 * 3600_000).toISOString())))
      .groupBy(serviceMetricsHourly.node_id),
  ]);

  // Quota hard-stop count mirrors GET /rules enrichment (same decision source).
  const ownerIds = [...new Set(ruleRows.map((r) => r.user_id).filter((id): id is number => id !== null))];
  const decisions = await quotaDecisionsForUsers(db, ownerIds);
  let quotaStopped = 0;
  for (const rule of ruleRows) {
    if (rule.user_id !== null && decisions.get(rule.user_id)?.stopped) quotaStopped += 1;
  }

  const rules = {
    total: ruleRows.length,
    running: ruleRows.filter((r) => r.status === "running").length,
    paused: ruleRows.filter((r) => r.status === "paused").length,
    created: ruleRows.filter((r) => r.status === "created").length,
    error: ruleRows.filter((r) => r.status === "error").length,
    quota_stopped: quotaStopped,
  };
  const usersAgg = { total: 0, active: 0, disabled: 0, subscribed: Number(subRows[0]?.n ?? 0) };
  for (const row of userRows) {
    usersAgg.total += Number(row.n);
    if (row.status === "active") usersAgg.active += Number(row.n);
    else usersAgg.disabled += Number(row.n);
  }

  const healthByNode = new Map<number, { services: number; ready: number; failed: number; last: string | null }>();
  for (const row of healthRows) {
    const cur = healthByNode.get(row.node_id) ?? { services: 0, ready: 0, failed: 0, last: null };
    cur.services += Number(row.n);
    if (row.state === "ready") cur.ready += Number(row.n);
    if (row.state === "failed" || row.state === "apply_failed") cur.failed += Number(row.n);
    if (row.last && (!cur.last || row.last > cur.last)) cur.last = row.last;
    healthByNode.set(row.node_id, cur);
  }
  const peakByNode = new Map(peakRows.map((r) => [r.node_id, Number(r.peak ?? 0)]));

  // Liveness: the heartbeat sentinel is the freshest row whenever the agent
  // beats; service rows only lag it (their reported_at rides the same beat).
  // MAX(sentinel, service rows) keeps nodes without a sentinel yet (upgrade
  // window) honest instead of dropping them to 未上报.
  const nowMs = Date.now();
  const seenByNode = new Map(seenRows.map((r) => [r.node_id, r.seen_at]));
  const lastReportOf = (nodeId: number): string | null => {
    const seen = seenByNode.get(nodeId) ?? null;
    const svc = healthByNode.get(nodeId)?.last ?? null;
    if (!seen) return svc;
    if (!svc) return seen;
    return seen > svc ? seen : svc;
  };

  const [today, yesterday] = await Promise.all([
    trafficForDay(db, dayStartIso(0), dayStartIso(1)),
    trafficForDay(db, dayStartIso(-1), dayStartIso(0)),
  ]);

  return {
    counts: {
      nodes: nodeRows.length,
      tunnels: Number(tunnelRows[0]?.n ?? 0),
      rules,
      users: usersAgg,
    },
    nodes_health: nodeRows.map((n) => {
      const h = healthByNode.get(n.id);
      const lastReport = lastReportOf(n.id);
      return {
        node_id: n.id,
        name: n.name,
        services: h?.services ?? 0,
        ready: h?.ready ?? 0,
        failed: h?.failed ?? 0,
        conn_peak_24h: peakByNode.get(n.id) ?? 0,
        last_report: lastReport,
        online: lastReport !== null && nowMs - Date.parse(lastReport) < OFFLINE_AFTER_MS,
      };
    }),
    traffic: { today, yesterday },
  };
}

/** Hourly billed traffic over the last `hours` hours, zero-filled (chart-ready). */
export async function dashboardTraffic(db: Database, hours: number): Promise<DashboardTrafficPoint[]> {
  const nowHour = hourFloorIso(new Date().toISOString());
  const startMs = Date.parse(nowHour) - (hours - 1) * 3600_000;
  const since = hourFloorIso(new Date(startMs).toISOString());
  const rows = await db
    .select({
      hour_ts: trafficHourly.hour_ts,
      upload: sql<number>`COALESCE(SUM(${trafficHourly.billed_upload}), 0)`,
      download: sql<number>`COALESCE(SUM(${trafficHourly.billed_download}), 0)`,
    })
    .from(trafficHourly)
    .where(gte(trafficHourly.hour_ts, since))
    .groupBy(trafficHourly.hour_ts);
  const byHour = new Map(rows.map((r) => [r.hour_ts, { upload: Number(r.upload), download: Number(r.download) }]));

  const points: DashboardTrafficPoint[] = [];
  for (let i = 0; i < hours; i++) {
    const hourTs = hourFloorIso(new Date(startMs + i * 3600_000).toISOString());
    const agg = byHour.get(hourTs);
    points.push({
      hour_ts: hourTs,
      billed_upload: agg?.upload ?? 0,
      billed_download: agg?.download ?? 0,
    });
  }
  return points;
}
