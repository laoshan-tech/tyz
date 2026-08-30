import type { Package, QuotaDecision, RelayRule, RuleQuotaStatus, User, UserSubscription } from "@tyz/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { nodeConfigs, packages, relayRules, trafficHourly, userPackages, users } from "../db/schema";
import { hourFloorIso } from "./traffic";

/**
 * Package/subscription enforcement shared by the config aggregator and the
 * admin API.
 *
 * Division of labor: the server is the billing ledger (usage is aggregated
 * from gost_stats snapshots), the agent is the enforcement point (its in-path
 * quota blocks at the remaining allowance pushed with the config). A rule is
 * EXCLUDED from the node config — a hard stop — when its owner has no usable
 * allowance left (disabled user, no subscription, expired subscription, or
 * exhausted traffic).
 *
 * The allowance is per USER, shared by every rule they own: all of a user's
 * rules reference one quota object (`quota-user-{id}`); GOST quotas with the
 * same name share a single counter, so rules on the same node count against
 * one budget. Rules spread across several nodes each get the same remaining
 * limit and count independently until the next recompute tightens it — the
 * ledger stays exact; in-path enforcement can overshoot by at most one
 * recompute interval of cross-node traffic.
 */

export interface ActiveSubscription {
  subscription: UserSubscription;
  pkg: Package;
  expired: boolean;
}

/** Load the active subscription (latest row; one per user by UNIQUE) per user id. */
export async function getActiveSubscriptions(
  db: Database,
  userIds: number[],
): Promise<Map<number, ActiveSubscription>> {
  const out = new Map<number, ActiveSubscription>();
  if (userIds.length === 0) return out;

  const rows = await db
    .select({ subscription: userPackages, pkg: packages })
    .from(userPackages)
    .innerJoin(packages, eq(packages.id, userPackages.package_id))
    .where(inArray(userPackages.user_id, userIds))
    .orderBy(userPackages.id);

  const now = new Date().toISOString();
  for (const row of rows) {
    out.set(row.subscription.user_id, {
      subscription: row.subscription,
      pkg: {
        ...row.pkg,
        note: row.pkg.note ?? undefined,
        node_ids: row.pkg.node_ids ?? null,
        tunnel_ids: row.pkg.tunnel_ids ?? null,
      },
      expired: row.subscription.expires_at !== null && row.subscription.expires_at <= now,
    });
  }
  return out;
}

export async function getUserStatuses(db: Database, userIds: number[]): Promise<Map<number, User>> {
  const out = new Map<number, User>();
  if (userIds.length === 0) return out;
  const rows = await db.select().from(users).where(inArray(users.id, userIds));
  for (const row of rows) {
    out.set(row.id, { ...row, note: row.note ?? undefined });
  }
  return out;
}

/**
 * CHARGED bytes used across ALL of one user's current rules since `sinceIso`,
 * from the hourly traffic ledger (billing source of truth — ingest-time UPSERT
 * accumulation of round(real × node rate)). One aggregate roundtrip via the
 * relay_rules subquery — the per-rule SUM loop this replaces was O(rules)
 * sequential D1 queries inside every node recompute. The window start is
 * floored to its containing hour, so at most one hour of pre-window traffic is
 * included: a conservative, one-time-per-window overcount that never
 * over-delivers allowance. Rules deleted mid-window keep their ledger rows (no
 * FK by design) but stop counting the moment they leave relay_rules.
 *
 * Built with the query builder, NOT raw `db.get(sql…)` — the D1 driver maps
 * that to a row object but the bun:sqlite driver (tests) to a bare value
 * array, which silently reads as 0. The builder path maps identically on both.
 */
async function userUsageBytes(db: Database, userId: number, sinceIso: string): Promise<number> {
  const used = sql<number>`COALESCE(SUM(${trafficHourly.billed_upload} + ${trafficHourly.billed_download}), 0)`;
  const rows = await db
    .select({ used })
    .from(trafficHourly)
    .where(
      and(
        gte(trafficHourly.hour_ts, hourFloorIso(sinceIso)),
        inArray(
          trafficHourly.rule_id,
          db.select({ id: relayRules.id }).from(relayRules).where(eq(relayRules.user_id, userId)),
        ),
      ),
    );
  return Number(rows[0]?.used ?? 0);
}

/**
 * CHARGED bytes per rule since `sinceIso` for a fixed set of rules — the
 * per-rule breakdown of userUsageBytes, one GROUP BY query per ≤90 rules
 * (D1's 100 bound-parameter cap).
 */
async function ruleUsageByRule(db: Database, ruleIds: number[], sinceIso: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ruleIds.length === 0) return out;
  const since = hourFloorIso(sinceIso);
  const used = sql<number>`COALESCE(SUM(${trafficHourly.billed_upload} + ${trafficHourly.billed_download}), 0)`;
  for (let i = 0; i < ruleIds.length; i += 90) {
    const rows = await db
      .select({ rule_id: trafficHourly.rule_id, used })
      .from(trafficHourly)
      .where(and(gte(trafficHourly.hour_ts, since), inArray(trafficHourly.rule_id, ruleIds.slice(i, i + 90))))
      .groupBy(trafficHourly.rule_id);
    for (const row of rows) out.set(row.rule_id, Number(row.used));
  }
  return out;
}

/**
 * Users + subscriptions, then one PARALLEL allowance pass — each decision is
 * an independent single aggregate; the sequential per-user loop this replaces
 * stacked every user's roundtrips onto admin lists and node recomputes.
 */
async function resolveQuotaDecisions(db: Database, userIds: number[]): Promise<Map<number, QuotaDecision>> {
  const out = new Map<number, QuotaDecision>();
  if (userIds.length === 0) return out;
  const [userById, subByUser] = await Promise.all([getUserStatuses(db, userIds), getActiveSubscriptions(db, userIds)]);
  const decisions = await Promise.all(
    userIds.map(async (id) => [id, await quotaForUser(db, userById.get(id), subByUser.get(id))] as const),
  );
  for (const [id, decision] of decisions) out.set(id, decision);
  return out;
}

/** Resolve allowance decisions for a set of users in one batch (admin lists). */
export async function quotaDecisionsForUsers(db: Database, userIds: number[]): Promise<Map<number, QuotaDecision>> {
  return resolveQuotaDecisions(db, userIds);
}

/**
 * Resolve one user's allowance. Usage is summed over ALL of the user's rules
 * (across nodes — the ledger follows the rule, not the node it currently
 * serves on).
 */
async function quotaForUser(
  db: Database,
  user: User | undefined,
  sub: ActiveSubscription | undefined,
): Promise<QuotaDecision> {
  if (!user || user.status !== "active") return { stopped: true, reason: "user_disabled" };
  if (!sub) return { stopped: true, reason: "no_subscription" };
  if (sub.expired) return { stopped: true, reason: "expired" };
  if (sub.pkg.traffic_bytes <= 0) return { stopped: false }; // unlimited traffic: nothing to enforce

  const used = await userUsageBytes(db, user.id, sub.subscription.activated_at);
  const remaining = sub.pkg.traffic_bytes - used;
  if (remaining <= 0) return { stopped: true, reason: "exhausted" };

  return {
    stopped: false,
    quota: {
      name: `quota-user-${user.id}`,
      limit_bytes: remaining,
      starts_at: sub.subscription.activated_at,
      expires_at: sub.subscription.expires_at ?? undefined,
    },
  };
}

/**
 * Filter and enrich rules for a node config: rules whose owner has no usable
 * allowance are dropped (hard stop, self-healing on every recompute); rules
 * with a metered package get the owner's shared quota with the remaining
 * allowance.
 */
export async function applyRuleQuotas(db: Database, rules: RelayRule[]): Promise<RelayRule[]> {
  const userIds = [...new Set(rules.map((r) => r.user_id).filter((id): id is number => id !== undefined))];
  const decisionByUser = await resolveQuotaDecisions(db, userIds);

  const out: RelayRule[] = [];
  for (const rule of rules) {
    if (rule.user_id === undefined) {
      out.push(rule); // admin-managed rule: never quota-gated
      continue;
    }
    const decision = decisionByUser.get(rule.user_id);
    if (!decision || decision.stopped) continue;
    out.push(decision.quota ? { ...rule, quota: decision.quota } : rule);
  }
  return out;
}

/**
 * Flush-driven hard-stop sweep (the R4 mitigation — see
 * docs/agent-realm-rust-refactor.md): the realm payload carries no in-agent
 * quota gate, so enforcement is config removal, which without this sweep
 * waited for the daily cron (up to a cron period of over-delivery). The stats
 * flush hands us the rule ids that just reported billed traffic; this resolves
 * their owners' hard-stop decisions and returns the users whose rules are
 * STILL deployed in some node config — the caller recomputes + notifies those
 * users' nodes, shrinking the over-delivery window to one flush interval.
 *
 * Idempotent per user: once the rules are out of every config, the deployment
 * scan short-circuits and later flushes (stale buffered samples, a slow agent
 * still reporting removed services) cost one indexed query. `stopped` covers
 * every hard-stop reason: the non-traffic reasons (disabled / expired / no
 * subscription) change via admin writes that already recompute, so reaching
 * this sweep for them means a previous recompute failed — the retry here is
 * pure self-heal, and the daily cron remains the backstop.
 */
export async function quotaSweepStoppedUsers(db: Database, ruleIds: number[]): Promise<number[]> {
  if (ruleIds.length === 0) return [];
  const ownerIds = new Set<number>();
  for (let i = 0; i < ruleIds.length; i += 90) {
    const rows = await db
      .select({ user_id: relayRules.user_id })
      .from(relayRules)
      .where(inArray(relayRules.id, ruleIds.slice(i, i + 90)));
    for (const r of rows) {
      if (r.user_id !== null) ownerIds.add(r.user_id);
    }
  }
  if (ownerIds.size === 0) return [];
  const decisions = await quotaDecisionsForUsers(db, [...ownerIds]);
  const stopped = [...ownerIds].filter((id) => decisions.get(id)?.stopped === true);
  if (stopped.length === 0) return [];

  // Still deployed somewhere? The snapshot table is tiny (one row per node)
  // and JSON.stringify is compact, so the `"name":"service-{id}"` needle is
  // exact (the closing quote rules out rule-id prefix collisions).
  const ruleRows = await db
    .select({ id: relayRules.id, user_id: relayRules.user_id })
    .from(relayRules)
    .where(inArray(relayRules.user_id, stopped));
  const snapshots = await db.select({ config_json: nodeConfigs.config_json }).from(nodeConfigs);
  const deployed = new Set<number>();
  for (const rule of ruleRows) {
    if (rule.user_id === null) continue; // unreachable via the IN(user ids) filter; satisfies the type
    if (deployed.has(rule.user_id)) continue;
    const needle = `"name":"service-${rule.id}"`;
    if (snapshots.some((s) => s.config_json.includes(needle))) deployed.add(rule.user_id);
  }
  return [...deployed];
}

/** Admin-facing usage summary for one user. */
export async function userQuotaSummary(
  db: Database,
  user: User,
  rules: RelayRule[],
): Promise<{ subscription: ActiveSubscription | null; decision: QuotaDecision; rules: RuleQuotaStatus[] }> {
  const sub = (await getActiveSubscriptions(db, [user.id])).get(user.id) ?? null;
  const decision = await quotaForUser(db, user, sub ?? undefined);
  const usedByRule =
    sub && sub.pkg.traffic_bytes > 0
      ? await ruleUsageByRule(
          db,
          rules.map((r) => r.id),
          sub.subscription.activated_at,
        )
      : new Map<number, number>();
  const statuses: RuleQuotaStatus[] = rules.map((rule) => ({
    rule_id: rule.id,
    rule_name: rule.name,
    used_bytes: usedByRule.get(rule.id) ?? 0,
  }));
  return { subscription: sub, decision, rules: statuses };
}
