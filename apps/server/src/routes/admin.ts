import type {
  AdminRuleRow,
  Chain,
  Endpoint,
  EndpointWithMeta,
  Package,
  TunnelWithMeta,
  User,
  UserSubscription,
} from "@tyz/shared";
import {
  ChainType,
  changePasswordSchema,
  createChainSchema,
  createEndpointSchema,
  createNodeSchema,
  createPackageSchema,
  createRuleSchema,
  createTunnelSchema,
  createUserSchema,
  endpointAddress,
  ForwardMode,
  loginSchema,
  type NodeWithMeta,
  setTlsDomainSchema,
  setTlsProfileSchema,
  subscribeSchema,
  TLS_LINK_TRANSPORTS,
  type Transport,
  updateChainSchema,
  updateEndpointSchema,
  updateNodeSchema,
  updatePackageSchema,
  updateRuleSchema,
  updateTunnelSchema,
  updateUserSchema,
} from "@tyz/shared";
import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createDb, type Database } from "../db";
import { nodeEntityColumns, recomputeNodeConfig, toRelayNode, toRelayRule, toTunnel } from "../db/repo";
import {
  chains,
  endpoints,
  gostStats,
  nodeConfigs,
  packages,
  relayNodes,
  relayRules,
  serviceHealth,
  serviceMetricsHourly,
  tunnels,
  userPackages,
  users,
} from "../db/schema";
import type { Bindings, Variables } from "../env";
import {
  adminAuth,
  clearSessionCookie,
  hasAdminAccount,
  issueSessionCookie,
  verifyAdminCredentials,
} from "../middleware/adminAuth";
import { listAudit, recordAudit } from "../services/audit";
import { dashboardSummary, dashboardTraffic } from "../services/dashboard";
import { broadcastNodeMessage, notifyConfigChanged } from "../services/notify";
import { getActiveSubscriptions, quotaDecisionsForUsers, userQuotaSummary } from "../services/quota";
import { recomputeAndNotify, recomputeTunnelNodes, recomputeUserNodes } from "../services/recompute";
import { getTlsDomain, getTlsStatus, setTlsDomain, setTlsProfile } from "../services/tls";
import { hashPassword } from "../utils/crypto";

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---- Auth ----

adminRoutes.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid login payload" }, 400);
  }
  if (!(await hasAdminAccount(c.env))) {
    // A distinct status so a fresh deployment fails loudly with setup guidance
    // instead of an ambiguous "wrong password" 401.
    return c.json({ error: "尚未创建管理员账号：请打开 /setup 页面完成初始化" }, 503);
  }
  if (!(await verifyAdminCredentials(c.env, parsed.data.username, parsed.data.password))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  await issueSessionCookie(c, parsed.data.username);
  return c.json({ ok: true, username: parsed.data.username });
});

adminRoutes.use("*", adminAuth());

adminRoutes.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

adminRoutes.get("/me", (c) => c.json({ username: c.get("adminName") }));

/** Change the logged-in admin's own password. Existing sessions stay valid (the
 *  session HMAC secret is independent of the password — see setup.ts). */
adminRoutes.put("/me/password", async (c) => {
  const parsed = changePasswordSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  const username = c.get("adminName");
  if (!(await verifyAdminCredentials(c.env, username, parsed.data.old_password))) {
    return c.json({ error: "当前密码不正确" }, 403);
  }
  await createDb(c.env.DB)
    .update(users)
    .set({ password_hash: await hashPassword(parsed.data.new_password), updated_at: new Date().toISOString() })
    .where(and(eq(users.role, "admin"), eq(users.name, username)));
  await recordAudit(c.env, {
    actor: username,
    action: "me.update_password",
    targetType: "user",
    targetId: username,
  });
  return c.json({ ok: true });
});

// ---- Helpers ----

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function now(): string {
  return new Date().toISOString();
}

function generateNodeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Schedule the post-write recompute+push AFTER the response is sent: an admin
 * write's latency is its row write + audit, and agent convergence is async
 * anyway (WS push → agent fetch → apply). waitUntil keeps the isolate alive
 * while the recompute finishes; failures are logged, not surfaced to the
 * operator — the daily cron's full recompute self-heals them, exactly like a
 * failed awaited recompute already did. The one exception is the explicit
 * POST /nodes/:id/recompute, which stays synchronous on purpose.
 */
function deferRecompute(c: Context<{ Bindings: Bindings; Variables: Variables }>, work: () => Promise<unknown>): void {
  c.executionCtx.waitUntil(work().catch((err) => console.error("deferred recompute failed", err)));
}

// ---- Forward-mode / TLS shape validation ----

interface TunnelShape {
  total: number;
  ins: number;
  outs: number;
  outTransport: Transport | null;
}

async function tunnelShape(db: Database, tunnelId: number): Promise<TunnelShape> {
  const rows = await db.select().from(chains).where(eq(chains.tunnel_id, tunnelId));
  const outs = rows.filter((r) => r.chain_type === ChainType.OUT);
  return {
    total: rows.length,
    ins: rows.filter((r) => r.chain_type === ChainType.IN).length,
    outs: outs.length,
    outTransport: (outs[0]?.transport as Transport) ?? null,
  };
}

/**
 * TLS shape rules: reject only states that can never be completed into the
 * valid 1-in / 1-out shape with the tls out transport (kaminari speaks TLS
 * only — see TLS_LINK_TRANSPORTS). A missing side (in-only or out-only) is
 * a construction intermediate — links are added one modal at a time, so the
 * strict "exactly two nodes" check would deadlock the very first chain write.
 * The renderer degrades intermediates to plaintext until the second link lands.
 */
function tlsShapeProblem(shape: TunnelShape): string | null {
  if (shape.ins > 1) return "TLS 隧道只允许一条入口链路";
  if (shape.outs > 1) return "TLS 隧道只允许一条出口链路";
  if (shape.outs === 1 && (shape.outTransport === null || !TLS_LINK_TRANSPORTS.has(shape.outTransport))) {
    return "TLS 要求出口链路的传输为 tls";
  }
  return null;
}

/**
 * Validate a TLS enablement against the tunnel's chain shape (forward_mode is
 * retired — every tunnel renders with raw port-pair semantics). Empty tunnels
 * (no chains yet) accept anything; the shape is judged once links exist, both
 * on tunnel updates and on chain writes.
 */
async function validateTunnelMode(
  db: Database,
  tunnelId: number,
  next: { tls_enabled?: boolean },
): Promise<string | null> {
  const row = await db.select().from(tunnels).where(eq(tunnels.id, tunnelId)).get();
  if (!row) return `tunnel ${tunnelId} not found`;
  const tlsEnabled = next.tls_enabled ?? row.tls_enabled;
  if (!tlsEnabled) return null;

  const shape = await tunnelShape(db, tunnelId);
  if (shape.total === 0) return null;
  const problem = tlsShapeProblem(shape);
  if (problem) return problem;
  if (!(await getTlsDomain(db))) return "请先在设置中配置 TLS 伪装域名";
  return null;
}

/** Recompute every node serving a TLS-enabled tunnel (domain/material changes). */
async function recomputeTlsNodes(env: Bindings): Promise<void> {
  const db = createDb(env.DB);
  const rows = await db
    .selectDistinct({ node_id: chains.node_id })
    .from(chains)
    .innerJoin(tunnels, eq(tunnels.id, chains.tunnel_id))
    .where(eq(tunnels.tls_enabled, true));
  for (const { node_id } of rows) {
    await recomputeAndNotify(env, node_id);
  }
}

async function nodeWithMeta(db: Database, id: number): Promise<NodeWithMeta | null> {
  const row = await db
    .select({ ...nodeEntityColumns, token_hint: relayNodes.token_hint, config_version: nodeConfigs.version })
    .from(relayNodes)
    .leftJoin(nodeConfigs, eq(nodeConfigs.node_id, relayNodes.id))
    .where(eq(relayNodes.id, id))
    .get();
  if (!row) return null;
  return {
    ...toRelayNode(row),
    config_version: row.config_version,
    token_hint: row.token_hint,
  };
}

// ---- Nodes ----

adminRoutes.get("/nodes", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({ ...nodeEntityColumns, token_hint: relayNodes.token_hint, config_version: nodeConfigs.version })
    .from(relayNodes)
    .leftJoin(nodeConfigs, eq(nodeConfigs.node_id, relayNodes.id))
    .orderBy(relayNodes.id);
  const nodes = rows.map((row) => ({
    ...toRelayNode(row),
    config_version: row.config_version,
    token_hint: row.token_hint,
  }));
  return c.json({ nodes });
});

adminRoutes.post("/nodes", async (c) => {
  const parsed = createNodeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid node payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const token = generateNodeToken();
  const ts = now();

  const [inserted] = await createDb(c.env.DB)
    .insert(relayNodes)
    .values({
      name: input.name,
      description: input.description ?? null,
      address: input.address,
      display_address: input.display_address ?? null,
      token,
      token_hint: token.slice(-4),
      version: input.version ?? null,
      level: input.level,
      is_public: input.is_public,
      ports: input.ports,
      traffic_limit: input.traffic_limit,
      rate: input.rate,
      custom_cfg: input.custom_cfg ?? null,
      tls_config: input.tls_config ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning({ id: relayNodes.id });

  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "node.create",
    targetType: "node",
    targetId: inserted.id,
    detail: input.name,
  });
  deferRecompute(c, () => recomputeAndNotify(c.env, inserted.id));
  const node = await nodeWithMeta(createDb(c.env.DB), inserted.id);
  return c.json({ node, token }, 201);
});

adminRoutes.get("/nodes/:id", async (c) => {
  const node = await nodeWithMeta(createDb(c.env.DB), Number(c.req.param("id")));
  if (!node) return c.json({ error: "node not found" }, 404);
  return c.json({ node });
});

adminRoutes.put("/nodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateNodeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid node payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;

  const patch: Partial<typeof relayNodes.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.address !== undefined) patch.address = input.address;
  if (input.display_address !== undefined) patch.display_address = input.display_address;
  if (input.version !== undefined) patch.version = input.version;
  if (input.level !== undefined) patch.level = input.level;
  if (input.is_public !== undefined) patch.is_public = input.is_public;
  if (input.ports !== undefined) patch.ports = input.ports;
  if (input.traffic_limit !== undefined) patch.traffic_limit = input.traffic_limit;
  if (input.rate !== undefined) patch.rate = input.rate;
  if (input.custom_cfg !== undefined) patch.custom_cfg = input.custom_cfg;
  if (input.tls_config !== undefined) patch.tls_config = input.tls_config;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  await createDb(c.env.DB).update(relayNodes).set(patch).where(eq(relayNodes.id, id)).run();
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "node.update",
    targetType: "node",
    targetId: id,
    detail: input.name ?? "",
  });

  deferRecompute(c, () => recomputeAndNotify(c.env, id));
  const node = await nodeWithMeta(createDb(c.env.DB), id);
  if (!node) return c.json({ error: "node not found" }, 404);
  return c.json({ node });
});

adminRoutes.delete("/nodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const tunnelRows = await db
    .selectDistinct({ tunnel_id: chains.tunnel_id })
    .from(chains)
    .where(eq(chains.node_id, id));

  const deleted = await db.delete(relayNodes).where(eq(relayNodes.id, id)).returning({ id: relayNodes.id });
  if (deleted.length === 0) {
    return c.json({ error: "node not found" }, 404);
  }
  deferRecompute(c, async () => {
    for (const { tunnel_id } of tunnelRows) {
      await recomputeTunnelNodes(c.env, tunnel_id);
    }
  });
  await recordAudit(c.env, { actor: c.get("adminName"), action: "node.delete", targetType: "node", targetId: id });
  return c.json({ ok: true });
});

adminRoutes.post("/nodes/:id/recompute", async (c) => {
  const id = Number(c.req.param("id"));
  const changed = await recomputeAndNotify(c.env, id);
  if (!changed) return c.json({ error: "node not found" }, 404);
  return c.json({ ok: true });
});

adminRoutes.post("/nodes/:id/rotate-token", async (c) => {
  const id = Number(c.req.param("id"));
  const token = generateNodeToken();
  const updated = await createDb(c.env.DB)
    .update(relayNodes)
    .set({ token, token_hint: token.slice(-4), updated_at: now() })
    .where(eq(relayNodes.id, id))
    .returning({ id: relayNodes.id });
  if (updated.length === 0) {
    return c.json({ error: "node not found" }, 404);
  }
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "node.rotate_token",
    targetType: "node",
    targetId: id,
  });
  return c.json({ id, token });
});

/** Reveal a node's plaintext token — the panel's masked display fetches this on demand. */
adminRoutes.get("/nodes/:id/token", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await createDb(c.env.DB)
    .select({ token: relayNodes.token })
    .from(relayNodes)
    .where(eq(relayNodes.id, id))
    .get();
  if (!row) {
    return c.json({ error: "node not found" }, 404);
  }
  return c.json({ token: row.token });
});

adminRoutes.get("/nodes/:id/stats", async (c) => {
  const id = Number(c.req.param("id"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  const rows = await createDb(c.env.DB)
    .select({
      id: gostStats.id,
      service: gostStats.service,
      stats: gostStats.stats,
      reported_at: gostStats.reported_at,
    })
    .from(gostStats)
    .where(eq(gostStats.node_id, id))
    .orderBy(desc(gostStats.id))
    .limit(limit);
  return c.json({ rows });
});

/** Hourly per-service connection rollup (avg via sum/samples, plus peak). */
adminRoutes.get("/nodes/:id/metrics", async (c) => {
  const id = Number(c.req.param("id"));
  const hours = Math.min(Number(c.req.query("hours") ?? 24), 168);
  const since = `${new Date(Date.now() - hours * 3600_000).toISOString().slice(0, 13)}:00:00.000Z`;
  const rows = await createDb(c.env.DB)
    .select()
    .from(serviceMetricsHourly)
    .where(and(eq(serviceMetricsHourly.node_id, id), gte(serviceMetricsHourly.hour_ts, since)))
    .orderBy(serviceMetricsHourly.hour_ts);
  return c.json({ rows });
});

/** Latest runtime state per service on a node, as reported with stats batches. */
adminRoutes.get("/nodes/:id/health", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await createDb(c.env.DB).select().from(serviceHealth).where(eq(serviceHealth.node_id, id));
  return c.json({ rows });
});

// ---- Tunnels ----

/** Chain count per tunnel id (drives the effective-mode display in the panel). */
async function chainCounts(db: Database): Promise<Map<number, number>> {
  const rows = await db.select({ tunnel_id: chains.tunnel_id, n: count() }).from(chains).groupBy(chains.tunnel_id);
  return new Map(rows.map((r) => [r.tunnel_id, r.n]));
}

adminRoutes.get("/tunnels", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(tunnels).orderBy(tunnels.id);
  const counts = await chainCounts(db);
  const list: TunnelWithMeta[] = rows.map((row) => ({
    ...toTunnel(row),
    chain_count: counts.get(row.id) ?? 0,
  }));
  return c.json({ tunnels: list });
});

adminRoutes.post("/tunnels", async (c) => {
  const parsed = createTunnelSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tunnel payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  // A fresh tunnel has no chains — mode/TLS shape is validated once links
  // exist (chain writes and tunnel updates), and normalized at aggregation.
  if (input.tls_enabled && !(await getTlsDomain(createDb(c.env.DB)))) {
    return c.json({ error: "请先在设置中配置 TLS 伪装域名" }, 400);
  }
  const ts = now();
  const [tunnel] = await createDb(c.env.DB)
    .insert(tunnels)
    .values({
      name: input.name,
      description: input.description ?? null,
      ingress_display_address: input.ingress_display_address ?? null,
      // forward_mode is retired; every tunnel stores raw. The relay-auth
      // columns are dormant (no protocol auth in the realm data plane) but
      // stay populated for schema stability.
      forward_mode: ForwardMode.RAW,
      tls_enabled: input.tls_enabled,
      relay_auth_user: `relay-${generateNodeToken().slice(0, 8)}`,
      relay_auth_pass: generateNodeToken(),
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  return c.json({ tunnel: { ...toTunnel(tunnel), chain_count: 0 } }, 201);
});

adminRoutes.put("/tunnels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateTunnelSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tunnel payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  if (input.tls_enabled !== undefined) {
    const problem = await validateTunnelMode(createDb(c.env.DB), id, {
      tls_enabled: input.tls_enabled,
    });
    if (problem) return c.json({ error: problem }, 400);
  }
  const patch: Partial<typeof tunnels.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.ingress_display_address !== undefined) patch.ingress_display_address = input.ingress_display_address;
  if (input.tls_enabled !== undefined) patch.tls_enabled = input.tls_enabled;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const updated = await createDb(c.env.DB)
    .update(tunnels)
    .set(patch)
    .where(eq(tunnels.id, id))
    .returning({ id: tunnels.id });
  if (updated.length === 0) {
    return c.json({ error: "tunnel not found" }, 404);
  }
  deferRecompute(c, () => recomputeTunnelNodes(c.env, id));
  const db = createDb(c.env.DB);
  const [tunnel] = await db.select().from(tunnels).where(eq(tunnels.id, id));
  const chainCount = (await db.select({ n: count() }).from(chains).where(eq(chains.tunnel_id, id)))[0]?.n ?? 0;
  return c.json({ tunnel: tunnel ? { ...toTunnel(tunnel), chain_count: chainCount } : null });
});

adminRoutes.delete("/tunnels/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const nodeRows = await db.selectDistinct({ node_id: chains.node_id }).from(chains).where(eq(chains.tunnel_id, id));

  const deleted = await db.delete(tunnels).where(eq(tunnels.id, id)).returning({ id: tunnels.id });
  if (deleted.length === 0) {
    return c.json({ error: "tunnel not found" }, 404);
  }
  // Chains cascade-deleted; the remaining nodes' snapshots must drop them.
  deferRecompute(c, async () => {
    for (const { node_id } of nodeRows) {
      await recomputeAndNotify(c.env, node_id);
    }
  });
  return c.json({ ok: true });
});

// ---- Chains ----

adminRoutes.get("/tunnels/:id/chains", async (c) => {
  const rows = await createDb(c.env.DB)
    .select()
    .from(chains)
    .where(eq(chains.tunnel_id, Number(c.req.param("id"))))
    .orderBy(chains.index);
  const list: Chain[] = rows;
  return c.json({ chains: list });
});

adminRoutes.post("/chains", async (c) => {
  const parsed = createChainSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid chain payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const db = createDb(c.env.DB);
  // Judge the post-write shape (the new chain included) against the tunnel's
  // stored mode flags — e.g. a third chain must not land on a raw tunnel.
  const before = await tunnelShape(db, input.tunnel_id);
  const projected: TunnelShape = { ...before, total: before.total + 1 };
  if (input.chain_type === ChainType.IN) projected.ins += 1;
  if (input.chain_type === ChainType.OUT) {
    projected.outs += 1;
    projected.outTransport = input.transport;
  }
  const problem = await validateProjectedShape(db, input.tunnel_id, projected);
  if (problem) return c.json({ error: problem }, 400);

  // The IN row's port is meaningless — entry services listen on each rule's
  // listen_port; chain ports serve out/chain rows (relay listener, hop dial
  // address). Force 0 so a stale form field can't smuggle a value in.
  const port = input.chain_type === ChainType.IN ? 0 : input.port;

  const ts = now();
  const [chain] = await db
    .insert(chains)
    .values({
      tunnel_id: input.tunnel_id,
      node_id: input.node_id,
      chain_type: input.chain_type,
      transport: input.transport,
      index: input.index,
      strategy: input.strategy,
      port,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  deferRecompute(c, () => recomputeTunnelNodes(c.env, input.tunnel_id));
  return c.json({ chain }, 201);
});

adminRoutes.put("/chains/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateChainSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid chain payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const existing = await db.select().from(chains).where(eq(chains.id, id)).get();
  if (!existing) {
    return c.json({ error: "chain not found" }, 404);
  }

  const input = parsed.data;
  const targetTunnel = input.tunnel_id ?? existing.tunnel_id;
  const projected = await tunnelShape(db, targetTunnel);
  if (targetTunnel === existing.tunnel_id) {
    // Fold the update into the current shape.
    if (existing.chain_type === ChainType.IN) projected.ins -= 1;
    if (existing.chain_type === ChainType.OUT) projected.outs -= 1;
    projected.total -= 1;
  }
  const nextType = input.chain_type ?? existing.chain_type;
  const nextTransport = input.transport ?? existing.transport;
  projected.total += 1;
  if (nextType === ChainType.IN) projected.ins += 1;
  if (nextType === ChainType.OUT) {
    projected.outs += 1;
    projected.outTransport = nextTransport;
  }
  const problem = await validateProjectedShape(db, targetTunnel, projected);
  if (problem) return c.json({ error: problem }, 400);

  const patch: Partial<typeof chains.$inferInsert> = {};
  if (input.tunnel_id !== undefined) patch.tunnel_id = input.tunnel_id;
  if (input.node_id !== undefined) patch.node_id = input.node_id;
  if (input.chain_type !== undefined) patch.chain_type = input.chain_type;
  if (input.transport !== undefined) patch.transport = input.transport;
  if (input.index !== undefined) patch.index = input.index;
  if (input.strategy !== undefined) patch.strategy = input.strategy;
  // IN rows never carry a port (see POST /chains); also zeroes a row whose
  // type is being flipped to in.
  if (nextType === ChainType.IN) patch.port = 0;
  else if (input.port !== undefined) patch.port = input.port;
  patch.updated_at = now();

  const updated = await db.update(chains).set(patch).where(eq(chains.id, id)).returning({ id: chains.id });
  if (updated.length === 0) {
    return c.json({ error: "chain not found" }, 404);
  }

  deferRecompute(c, async () => {
    await recomputeTunnelNodes(c.env, existing.tunnel_id);
    if (input.tunnel_id !== undefined && input.tunnel_id !== existing.tunnel_id) {
      await recomputeTunnelNodes(c.env, input.tunnel_id);
    }
  });
  const [chain] = await db.select().from(chains).where(eq(chains.id, id));
  return c.json({ chain: chain ?? null });
});

adminRoutes.delete("/chains/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const existing = await db.select().from(chains).where(eq(chains.id, id)).get();
  if (!existing) {
    return c.json({ error: "chain not found" }, 404);
  }
  // Deleting one link of a COMPLETE TLS tunnel would silently downgrade the
  // live link to plaintext — the operator must turn TLS off first. Incomplete
  // shapes (still under construction) may delete freely.
  const tunnel = await db.select().from(tunnels).where(eq(tunnels.id, existing.tunnel_id)).get();
  if (tunnel?.tls_enabled) {
    const shape = await tunnelShape(db, existing.tunnel_id);
    if (shape.ins === 1 && shape.outs === 1) {
      return c.json({ error: "TLS 隧道必须保持两节点形态，请先关闭 TLS 再删除链路" }, 400);
    }
  }
  await db.delete(chains).where(eq(chains.id, id)).run();
  deferRecompute(c, () => recomputeTunnelNodes(c.env, existing.tunnel_id));
  return c.json({ ok: true });
});

/** Shape rules shared by chain create/update against the tunnel's mode flags.
 * Raw semantics (the only semantics now): at most one in link, any number of
 * out links (multiple outs form the tunnel's LB exit set), no middle hops
 * (the schema rejects chain-type rows). TLS tunnels additionally require the
 * 1-in/1-out shape with the tls out transport. */
async function validateProjectedShape(db: Database, tunnelId: number, shape: TunnelShape): Promise<string | null> {
  const row = await db.select().from(tunnels).where(eq(tunnels.id, tunnelId)).get();
  if (!row) return `tunnel ${tunnelId} not found`;
  if (shape.ins > 1) return "隧道只允许一条入口链路";
  if (row.tls_enabled && shape.total > 0) return tlsShapeProblem(shape);
  return null;
}

// ---- Relay rules ----

/**
 * Validate a user-owned rule against its owner's package: subscription state,
 * tunnel/node access rights, and the rule-count limit. Returns an error
 * message, or null when the write is allowed. Admin-owned rules (no user_id)
 * are never gated.
 */
async function validateRuleOwnership(
  db: Database,
  userId: number,
  tunnelId: number | null,
  excludeRuleId?: number,
): Promise<string | null> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return `user ${userId} not found`;
  if (user.status !== "active") return `user ${userId} is disabled`;
  const sub = (await getActiveSubscriptions(db, [userId])).get(userId);
  if (!sub) return `user ${userId} has no active subscription`;
  if (sub.expired) return `subscription of user ${userId} (package ${sub.pkg.name}) has expired`;

  if (tunnelId !== null) {
    if (sub.pkg.tunnel_ids !== null && !sub.pkg.tunnel_ids.includes(tunnelId)) {
      return `package ${sub.pkg.name} does not grant access to tunnel ${tunnelId}`;
    }
    if (sub.pkg.node_ids !== null) {
      const chainRows = await db
        .selectDistinct({ node_id: chains.node_id })
        .from(chains)
        .where(eq(chains.tunnel_id, tunnelId));
      const missing = chainRows.map((r) => r.node_id).filter((id) => !sub.pkg.node_ids?.includes(id));
      if (missing.length > 0) {
        return `package ${sub.pkg.name} does not grant access to node(s) ${missing.join(", ")} of tunnel ${tunnelId}`;
      }
    }
  }

  if (sub.pkg.max_rules > 0) {
    const owned = await db.select({ id: relayRules.id }).from(relayRules).where(eq(relayRules.user_id, userId));
    const count = owned.filter((r) => r.id !== excludeRuleId).length;
    if (count >= sub.pkg.max_rules) {
      return `package ${sub.pkg.name} allows at most ${sub.pkg.max_rules} rules (user ${userId} already has ${count})`;
    }
  }
  return null;
}

adminRoutes.get("/rules", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(relayRules).orderBy(relayRules.id);
  const rules: AdminRuleRow[] = rows.map(toRelayRule);
  // Attach the derived quota state so the panel can show WHY a user-owned
  // rule is not being served (paused vs quota-stopped are different states).
  const userIds = [...new Set(rules.map((r) => r.user_id).filter((id): id is number => id !== undefined))];
  const decisions = await quotaDecisionsForUsers(db, userIds);
  for (const rule of rules) {
    if (rule.user_id === undefined) continue;
    const decision = decisions.get(rule.user_id);
    if (decision?.stopped) {
      rule.quota_stopped = true;
      rule.quota_reason = decision.reason;
    }
  }
  return c.json({ rules });
});

adminRoutes.post("/rules", async (c) => {
  const parsed = createRuleSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid rule payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  // tunnel_id is required (see createRuleSchema): a rule outside a tunnel is
  // never aggregated into any node config. Reject unknown tunnels up front
  // instead of relying on the FK.
  const tunnel = await createDb(c.env.DB)
    .select({ id: tunnels.id })
    .from(tunnels)
    .where(eq(tunnels.id, input.tunnel_id))
    .get();
  if (!tunnel) {
    return c.json({ error: `tunnel ${input.tunnel_id} not found` }, 400);
  }
  if (input.user_id) {
    const problem = await validateRuleOwnership(createDb(c.env.DB), input.user_id, input.tunnel_id);
    if (problem) return c.json({ error: problem }, 400);
  }
  // An associated endpoint is authoritative for `targets` — the composed
  // address is resolved server-side so rules can never drift from the endpoint.
  let targets = input.targets;
  if (input.endpoint_id) {
    const endpoint = await createDb(c.env.DB).select().from(endpoints).where(eq(endpoints.id, input.endpoint_id)).get();
    if (!endpoint) {
      return c.json({ error: `endpoint ${input.endpoint_id} not found` }, 400);
    }
    targets = endpointAddress(endpoint.host, endpoint.port);
  }
  const ts = now();
  const [rule] = await createDb(c.env.DB)
    .insert(relayRules)
    .values({
      name: input.name,
      description: input.description ?? null,
      listen_port: input.listen_port,
      tunnel_id: input.tunnel_id,
      user_id: input.user_id ?? null,
      endpoint_id: input.endpoint_id ?? null,
      targets,
      status: input.status,
      exit_port: input.exit_port,
      limit: input.limit ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  deferRecompute(c, () => recomputeTunnelNodes(c.env, input.tunnel_id));
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "rule.create",
    targetType: "rule",
    targetId: rule.id,
    detail: rule.name,
  });
  return c.json({ rule: toRelayRule(rule) }, 201);
});

adminRoutes.put("/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateRuleSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid rule payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const existing = await db
    .select({ tunnel_id: relayRules.tunnel_id, user_id: relayRules.user_id, endpoint_id: relayRules.endpoint_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!existing) {
    return c.json({ error: "rule not found" }, 404);
  }

  const input = parsed.data;
  const finalUserId = input.user_id !== undefined ? input.user_id : existing.user_id;
  const finalTunnelId = input.tunnel_id !== undefined ? input.tunnel_id : existing.tunnel_id;
  if (finalUserId) {
    const problem = await validateRuleOwnership(db, finalUserId, finalTunnelId ?? null, id);
    if (problem) return c.json({ error: problem }, 400);
  }

  // Association resolution: a set endpoint is authoritative for `targets`;
  // input.endpoint_id === null disassociates back to a manual address.
  const finalEndpointId = input.endpoint_id !== undefined ? input.endpoint_id : existing.endpoint_id;
  let endpoint: typeof endpoints.$inferSelect | undefined;
  if (finalEndpointId) {
    endpoint = await db.select().from(endpoints).where(eq(endpoints.id, finalEndpointId)).get();
    if (!endpoint) {
      return c.json({ error: `endpoint ${finalEndpointId} not found` }, 400);
    }
  }

  const patch: Partial<typeof relayRules.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.listen_port !== undefined) patch.listen_port = input.listen_port;
  if (input.tunnel_id !== undefined) patch.tunnel_id = input.tunnel_id;
  if (input.user_id !== undefined) patch.user_id = input.user_id;
  if (input.endpoint_id !== undefined) patch.endpoint_id = input.endpoint_id;
  if (endpoint) {
    patch.targets = endpointAddress(endpoint.host, endpoint.port);
  } else if (input.targets !== undefined) {
    patch.targets = input.targets;
  }
  if (input.status !== undefined) patch.status = input.status;
  if (input.exit_port !== undefined) patch.exit_port = input.exit_port;
  if (input.limit !== undefined) patch.limit = input.limit;
  patch.updated_at = now();

  const updated = await db.update(relayRules).set(patch).where(eq(relayRules.id, id)).returning({ id: relayRules.id });
  if (updated.length === 0) {
    return c.json({ error: "rule not found" }, 404);
  }

  const affected = new Set<number>();
  if (existing.tunnel_id) affected.add(existing.tunnel_id);
  if (input.tunnel_id) affected.add(input.tunnel_id);
  deferRecompute(c, async () => {
    for (const tunnelId of affected) {
      await recomputeTunnelNodes(c.env, tunnelId);
    }
  });
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "rule.update",
    targetType: "rule",
    targetId: id,
    detail: input.name ?? "",
  });

  const [row] = await db.select().from(relayRules).where(eq(relayRules.id, id));
  return c.json({ rule: row ? toRelayRule(row) : null });
});

adminRoutes.delete("/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const existing = await db
    .select({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!existing) {
    return c.json({ error: "rule not found" }, 404);
  }
  await db.delete(relayRules).where(eq(relayRules.id, id)).run();
  if (existing.tunnel_id) {
    const tunnelId = existing.tunnel_id;
    deferRecompute(c, () => recomputeTunnelNodes(c.env, tunnelId));
  }
  await recordAudit(c.env, { actor: c.get("adminName"), action: "rule.delete", targetType: "rule", targetId: id });
  return c.json({ ok: true });
});

/**
 * Manual rule restart (C2): a PURE restart, not a state transition. Broadcasts
 * a restart_service directive to every node of the rule's tunnel; the entry
 * node holding service-{id} rebuilds it from its last applied config (dropping
 * live connections), other nodes no-op. A rule without a tunnel is not
 * deployed anywhere — nothing to restart.
 */
adminRoutes.post("/rules/:id/restart", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const rule = await db
    .select({ name: relayRules.name, tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.id, id))
    .get();
  if (!rule) return c.json({ error: "rule not found" }, 404);
  if (rule.tunnel_id === null) return c.json({ error: "rule is not deployed on any tunnel" }, 400);

  const rows = await db
    .selectDistinct({ node_id: chains.node_id })
    .from(chains)
    .where(eq(chains.tunnel_id, rule.tunnel_id));
  const nodeIds = rows.map((r) => r.node_id);
  await broadcastNodeMessage(c.env, nodeIds, { type: "restart_service", service: `service-${id}` });
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "rule.restart",
    targetType: "rule",
    targetId: id,
    detail: rule.name,
  });
  return c.json({ ok: true, nodes: nodeIds.length });
});

/**
 * Zero the rule's OBSERVATION counters (upload/download_traffic) so the owner
 * can restart measuring. The billing ledger (traffic_hourly) is untouched:
 * quota windows are computed from it, and zeroing it would hand back
 * allowance. The counters resume accumulating on the next stats ingest.
 */
adminRoutes.post("/rules/:id/reset-traffic", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const rule = await db.select({ name: relayRules.name }).from(relayRules).where(eq(relayRules.id, id)).get();
  if (!rule) return c.json({ error: "rule not found" }, 404);
  await db
    .update(relayRules)
    .set({ upload_traffic: 0, download_traffic: 0, updated_at: now() })
    .where(eq(relayRules.id, id));
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "rule.reset_traffic",
    targetType: "rule",
    targetId: id,
    detail: rule.name,
  });
  return c.json({ ok: true });
});

// ---- Target endpoints ----

/**
 * Named forwarding destinations rules can reference. `relay_rules.targets`
 * keeps its own copy of the composed address (the config pipeline never joins
 * endpoints); host/port edits re-sync referencing rules here, so the two can
 * only drift through direct DB writes.
 */
function toEndpoint(row: typeof endpoints.$inferSelect): Endpoint {
  return { ...row, note: row.note ?? undefined };
}

adminRoutes.get("/endpoints", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      id: endpoints.id,
      name: endpoints.name,
      host: endpoints.host,
      port: endpoints.port,
      note: endpoints.note,
      created_at: endpoints.created_at,
      updated_at: endpoints.updated_at,
      rule_count: count(relayRules.id),
    })
    .from(endpoints)
    .leftJoin(relayRules, eq(relayRules.endpoint_id, endpoints.id))
    .groupBy(endpoints.id)
    .orderBy(endpoints.id);
  const list: EndpointWithMeta[] = rows.map(({ note, ...row }) => ({ ...row, note: note ?? undefined }));
  return c.json({ endpoints: list });
});

adminRoutes.post("/endpoints", async (c) => {
  const parsed = createEndpointSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid endpoint payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const ts = now();
  const [row] = await createDb(c.env.DB)
    .insert(endpoints)
    .values({
      name: input.name,
      host: input.host,
      port: input.port,
      note: input.note ?? null,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "endpoint.create",
    targetType: "endpoint",
    targetId: row.id,
    detail: row.name,
  });
  return c.json({ endpoint: toEndpoint(row) }, 201);
});

adminRoutes.put("/endpoints/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updateEndpointSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid endpoint payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const db = createDb(c.env.DB);
  const existing = await db.select().from(endpoints).where(eq(endpoints.id, id)).get();
  if (!existing) {
    return c.json({ error: "endpoint not found" }, 404);
  }

  const patch: Partial<typeof endpoints.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.host !== undefined) patch.host = input.host;
  if (input.port !== undefined) patch.port = input.port;
  if (input.note !== undefined) patch.note = input.note;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();
  const [row] = await db.update(endpoints).set(patch).where(eq(endpoints.id, id)).returning();

  // Address change: re-sync every referencing rule's targets, then recompute
  // their tunnels (content-diffed — version bump + WS push only on real changes).
  const hostChanged = input.host !== undefined && input.host !== existing.host;
  const portChanged = input.port !== undefined && input.port !== existing.port;
  if (hostChanged || portChanged) {
    const address = endpointAddress(row.host, row.port);
    const rules = await db
      .update(relayRules)
      .set({ targets: address, updated_at: now() })
      .where(eq(relayRules.endpoint_id, id))
      .returning({ tunnel_id: relayRules.tunnel_id });
    const tunnelIds = new Set(rules.map((r) => r.tunnel_id).filter((t): t is number => t !== null));
    deferRecompute(c, async () => {
      for (const tunnelId of tunnelIds) {
        await recomputeTunnelNodes(c.env, tunnelId);
      }
    });
  }
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "endpoint.update",
    targetType: "endpoint",
    targetId: id,
    detail: row.name,
  });
  return c.json({ endpoint: toEndpoint(row) });
});

adminRoutes.delete("/endpoints/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const refs = await db.select({ id: relayRules.id }).from(relayRules).where(eq(relayRules.endpoint_id, id));
  if (refs.length > 0) {
    return c.json({ error: `endpoint is referenced by ${refs.length} rule(s)` }, 409);
  }
  const deleted = await db.delete(endpoints).where(eq(endpoints.id, id)).returning({ id: endpoints.id });
  if (deleted.length === 0) {
    return c.json({ error: "endpoint not found" }, 404);
  }
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "endpoint.delete",
    targetType: "endpoint",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ---- Users (tenants) ----

function toUser(row: typeof users.$inferSelect): User {
  // Explicit field pick: the table also carries login material (password_hash) and
  // the internal role column — neither may ever reach an API response.
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? undefined,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPackage(row: typeof packages.$inferSelect): Package {
  return {
    ...row,
    note: row.note ?? undefined,
    node_ids: row.node_ids ?? null,
    tunnel_ids: row.tunnel_ids ?? null,
  };
}

adminRoutes.get("/users", async (c) => {
  const db = createDb(c.env.DB);
  // Admin accounts are operators, not business tenants — the panel's user
  // management (subscriptions/quota) never sees them.
  const rows = await db.select().from(users).where(ne(users.role, "admin")).orderBy(users.id);
  const subs = await getActiveSubscriptions(
    db,
    rows.map((r) => r.id),
  );
  return c.json({
    users: rows.map((row) => {
      const sub = subs.get(row.id);
      return {
        ...toUser(row),
        subscription: sub ? { package_id: sub.pkg.id, package_name: sub.pkg.name, expired: sub.expired } : null,
      };
    }),
  });
});

adminRoutes.post("/users", async (c) => {
  const parsed = createUserSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid user payload", detail: parsed.error.flatten() }, 400);
  }
  const ts = now();
  const [row] = await createDb(c.env.DB)
    .insert(users)
    .values({
      name: parsed.data.name,
      note: parsed.data.note ?? null,
      status: parsed.data.status,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "user.create",
    targetType: "user",
    targetId: row.id,
    detail: row.name,
  });
  return c.json({ user: toUser(row) }, 201);
});

/** Admin rows are shielded from business user management: reads 404, mutations 409. */
async function isUserRowAdmin(db: Database, id: number): Promise<boolean> {
  const row = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
  return row?.role === "admin";
}

/** User detail incl. its rules' quota status (used/remaining/stopped reasons). */
adminRoutes.get("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const row = await db.select().from(users).where(eq(users.id, id)).get();
  if (!row || row.role === "admin") return c.json({ error: "user not found" }, 404);
  const owned = await db.select().from(relayRules).where(eq(relayRules.user_id, id));
  const summary = await userQuotaSummary(db, toUser(row), owned.map(toRelayRule));
  return c.json({ user: toUser(row), ...summary });
});

adminRoutes.put("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (await isUserRowAdmin(createDb(c.env.DB), id)) {
    return c.json({ error: "管理员账号不通过用户管理接口修改" }, 409);
  }
  const parsed = updateUserSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid user payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.note !== undefined) patch.note = input.note;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const updated = await createDb(c.env.DB).update(users).set(patch).where(eq(users.id, id)).returning();
  if (updated.length === 0) {
    return c.json({ error: "user not found" }, 404);
  }
  if (input.status !== undefined) {
    // Disabling/reactivating changes whether the user's rules are served.
    deferRecompute(c, () => recomputeUserNodes(c.env, id));
  }
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "user.update",
    targetType: "user",
    targetId: id,
    detail: input.status !== undefined ? `status=${input.status}` : (input.name ?? ""),
  });
  return c.json({ user: toUser(updated[0]) });
});

adminRoutes.delete("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  if (await isUserRowAdmin(db, id)) {
    return c.json({ error: "管理员账号不能删除" }, 409);
  }
  // Collect affected tunnels BEFORE the delete: the FK then sets rules.user_id
  // to NULL (rules become admin-managed), so they can no longer be found via
  // the user — the affected nodes must drop their quota objects.
  const tunnelsOf = await db
    .selectDistinct({ tunnel_id: relayRules.tunnel_id })
    .from(relayRules)
    .where(eq(relayRules.user_id, id));
  const deleted = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  if (deleted.length === 0) {
    return c.json({ error: "user not found" }, 404);
  }
  deferRecompute(c, async () => {
    for (const { tunnel_id } of tunnelsOf) {
      if (tunnel_id !== null) {
        await recomputeTunnelNodes(c.env, tunnel_id);
      }
    }
  });
  await recordAudit(c.env, { actor: c.get("adminName"), action: "user.delete", targetType: "user", targetId: id });
  return c.json({ ok: true });
});

/**
 * Activate/switch/renew a user's subscription (换购/续费). Replaces the row
 * with a fresh activated_at: the usage window restarts, so historically used
 * traffic clears on the ledger AND on the agent-side quota counter.
 */
adminRoutes.post("/users/:id/subscribe", async (c) => {
  const userId = Number(c.req.param("id"));
  const parsed = subscribeSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid subscribe payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  if (await isUserRowAdmin(db, userId)) {
    return c.json({ error: "管理员账号不参与套餐订阅" }, 409);
  }
  const user = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!user) return c.json({ error: "user not found" }, 404);
  const pkg = await db.select().from(packages).where(eq(packages.id, parsed.data.package_id)).get();
  if (!pkg) return c.json({ error: "package not found" }, 404);

  const ts = now();
  const expiresAt =
    pkg.period_days > 0 ? new Date(Date.now() + pkg.period_days * 24 * 60 * 60 * 1000).toISOString() : null;
  const [sub] = await db
    .insert(userPackages)
    .values({
      user_id: userId,
      package_id: pkg.id,
      package_name: pkg.name, // snapshot frozen at subscribe time
      traffic_bytes: pkg.traffic_bytes,
      activated_at: ts,
      expires_at: expiresAt,
      created_at: ts,
      updated_at: ts,
    })
    .onConflictDoUpdate({
      target: userPackages.user_id,
      set: {
        package_id: pkg.id,
        package_name: pkg.name,
        traffic_bytes: pkg.traffic_bytes,
        activated_at: ts,
        expires_at: expiresAt,
        updated_at: ts,
      },
    })
    .returning();

  deferRecompute(c, () => recomputeUserNodes(c.env, userId));
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "subscribe",
    targetType: "user",
    targetId: userId,
    detail: `package ${pkg.name} (#${pkg.id}), expires ${expiresAt ?? "never"}`,
  });
  const subscription: UserSubscription = { ...sub, expires_at: sub.expires_at ?? null };
  return c.json({ subscription });
});

// ---- Packages (plans) ----

// ---- Link TLS (platform certs) ----

/** Expiry metadata only — cert/key PEMs never leave the agent config channel. */
adminRoutes.get("/tls/status", async (c) => {
  return c.json(await getTlsStatus(createDb(c.env.DB)));
});

/**
 * Set the platform-wide disguise domain (SNI / serverName / server cert SAN).
 * A real change re-issues the server certificate; a same-value write is a
 * no-op. Nodes of TLS tunnels pick up new material via the ordinary
 * recompute → WS push cycle.
 */
adminRoutes.put("/settings/tls-domain", async (c) => {
  const parsed = setTlsDomainSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tls domain payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const previous = await getTlsDomain(db);
  const { changed, issued } = await setTlsDomain(db, parsed.data.domain);
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "settings.tls_domain",
    targetType: "settings",
    targetId: "tls_domain",
    detail: changed ? `${previous ?? "(unset)"} -> ${parsed.data.domain}` : `unchanged (${parsed.data.domain})`,
  });
  if (changed) {
    deferRecompute(c, () => recomputeTlsNodes(c.env));
  }
  return c.json({ ok: true, domain: parsed.data.domain, changed, issued });
});

/**
 * Edit the observable certificate profile (issuer DN strings, validity).
 * CA identity changes rotate the whole set — the link re-handshakes while
 * entry and exit converge on the recompute+push; leaf-only changes re-issue
 * the leaves under the existing CA. Public metadata only — safe to audit.
 */
adminRoutes.put("/settings/tls-profile", async (c) => {
  const parsed = setTlsProfileSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid tls profile payload", detail: parsed.error.flatten() }, 400);
  }
  const db = createDb(c.env.DB);
  const result = await setTlsProfile(db, parsed.data);
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "settings.tls_profile",
    targetType: "settings",
    targetId: "tls_profile",
    detail: `CA=${result.profile.ca_common_name} O=${result.profile.ca_organization || "(none)"} \
leafDays=${result.profile.leaf_validity_days} caDays=${result.profile.ca_validity_days} regenerated=${result.regenerated}`,
  });
  if (result.regenerated !== "none") {
    // "issued" means material just appeared — recompute is usually a no-op (no
    // TLS tunnel can be serving before material existed) but stays cheap and
    // covers a hand-wiped tls_material while a tunnel was already enabled.
    deferRecompute(c, () => recomputeTlsNodes(c.env));
  }
  return c.json({ ok: true, ...result });
});

/** Admin audit trail, newest first. */
adminRoutes.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  return c.json({ rows: await listAudit(c.env, limit) });
});

// ---- Dashboard (read-only aggregations for the panel front page) ----

adminRoutes.get("/dashboard/summary", async (c) => {
  return c.json(await dashboardSummary(createDb(c.env.DB)));
});

adminRoutes.get("/dashboard/traffic", async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24), 1), 168);
  const rows = await dashboardTraffic(createDb(c.env.DB), hours);
  return c.json({ hours, rows });
});

adminRoutes.get("/packages", async (c) => {
  const rows = await createDb(c.env.DB).select().from(packages).orderBy(packages.id);
  return c.json({ packages: rows.map(toPackage) });
});

adminRoutes.post("/packages", async (c) => {
  const parsed = createPackageSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid package payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const ts = now();
  const [row] = await createDb(c.env.DB)
    .insert(packages)
    .values({
      name: input.name,
      note: input.note ?? null,
      traffic_bytes: input.traffic_bytes,
      period_days: input.period_days,
      node_ids: input.node_ids ?? null,
      tunnel_ids: input.tunnel_ids ?? null,
      max_rules: input.max_rules,
      created_at: ts,
      updated_at: ts,
    })
    .returning();
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "package.create",
    targetType: "package",
    targetId: row.id,
    detail: row.name,
  });
  return c.json({ package: toPackage(row) }, 201);
});

adminRoutes.put("/packages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = updatePackageSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "invalid package payload", detail: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const patch: Partial<typeof packages.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.note !== undefined) patch.note = input.note;
  if (input.traffic_bytes !== undefined) patch.traffic_bytes = input.traffic_bytes;
  if (input.period_days !== undefined) patch.period_days = input.period_days;
  if (input.node_ids !== undefined) patch.node_ids = input.node_ids;
  if (input.tunnel_ids !== undefined) patch.tunnel_ids = input.tunnel_ids;
  if (input.max_rules !== undefined) patch.max_rules = input.max_rules;
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  patch.updated_at = now();

  const db = createDb(c.env.DB);
  const updated = await db.update(packages).set(patch).where(eq(packages.id, id)).returning();
  if (updated.length === 0) {
    return c.json({ error: "package not found" }, 404);
  }

  // Allowance/access changes propagate to every subscriber's nodes.
  const subs = await db
    .selectDistinct({ user_id: userPackages.user_id })
    .from(userPackages)
    .where(eq(userPackages.package_id, id));
  deferRecompute(c, async () => {
    for (const { user_id } of subs) {
      await recomputeUserNodes(c.env, user_id);
    }
  });
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "package.update",
    targetType: "package",
    targetId: id,
    detail: updated[0].name,
  });
  return c.json({ package: toPackage(updated[0]) });
});

adminRoutes.delete("/packages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = createDb(c.env.DB);
  const subs = await db.select({ id: userPackages.id }).from(userPackages).where(eq(userPackages.package_id, id));
  if (subs.length > 0) {
    return c.json({ error: "package is in use by an active subscription" }, 409);
  }
  const deleted = await db.delete(packages).where(eq(packages.id, id)).returning({ id: packages.id });
  if (deleted.length === 0) {
    return c.json({ error: "package not found" }, 404);
  }
  await recordAudit(c.env, {
    actor: c.get("adminName"),
    action: "package.delete",
    targetType: "package",
    targetId: id,
  });
  return c.json({ ok: true });
});
