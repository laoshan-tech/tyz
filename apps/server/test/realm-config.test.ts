/**
 * buildRealmNodeConfig renderer tests against a real SQLite database (the D1
 * migration loaded into bun:sqlite) — the raw port-pair semantics, the
 * deterministic exit-port formula, the LB candidate set, TLS legs, legacy
 * relay rows degrading to raw, multi-hop skips, quota gating, and the
 * billing authorization set (nodeRuleTunnels).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RealmNodeConfig } from "@tyz/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database as AppDb } from "../src/db";
import { buildRealmNodeConfig, parseTargetAddress, recomputeNodeConfig } from "../src/db/repo";
import * as schema from "../src/db/schema";
import { quotaSweepStoppedUsers } from "../src/services/quota";
import { nodeRuleTunnels } from "../src/services/traffic";

function makeDb(): AppDb {
  const sqlite = new Database(":memory:");
  const migration = readFileSync(`${import.meta.dir}/../migrations/0001_init.sql`, "utf8");
  const ddl = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  for (const stmt of ddl.split(";")) {
    if (stmt.trim() !== "") sqlite.run(stmt);
  }
  return drizzle(sqlite, { schema }) as unknown as AppDb;
}

interface SeedOpts {
  forwardMode?: string;
  tlsEnabled?: boolean;
  outTransport?: string;
  inStrategy?: string;
}

async function seedTwoNodeTunnel(
  db: AppDb,
  ids: { tunnel: number; inNode: number; outNode: number; rule: number },
  opts: SeedOpts = {},
): Promise<void> {
  await db.insert(schema.tunnels).values({
    id: ids.tunnel,
    name: `tunnel-${ids.tunnel}`,
    forward_mode: opts.forwardMode ?? "relay",
    tls_enabled: opts.tlsEnabled ?? false,
  });
  await db.insert(schema.chains).values([
    {
      tunnel_id: ids.tunnel,
      node_id: ids.inNode,
      chain_type: "in",
      transport: "raw",
      index: 0,
      strategy: opts.inStrategy ?? "round",
    },
    {
      tunnel_id: ids.tunnel,
      node_id: ids.outNode,
      chain_type: "out",
      transport: opts.outTransport ?? "raw",
      index: 1,
      strategy: "round",
    },
  ]);
  await db.insert(schema.relayRules).values({
    id: ids.rule,
    name: `rule-${ids.rule}`,
    listen_port: 16500 + ids.rule,
    tunnel_id: ids.tunnel,
    targets: "target.example.org:443",
  });
}

async function seedBase(db: AppDb): Promise<void> {
  await db.insert(schema.relayNodes).values([
    { id: 1, name: "entry-1", address: "10.0.0.1", token: "tok-1", ports: "20000-20100" },
    { id: 2, name: "exit-a", address: "10.0.0.2", token: "tok-2", ports: "30000-30100" },
    { id: 3, name: "exit-b", address: "10.0.0.3", token: "tok-3", ports: "31000-31100" },
  ]);
}

function serviceOf(config: RealmNodeConfig, name: string) {
  return config.services.find((s) => s.name === name);
}

/** The legacy deterministic allocation: start + (ruleId*31 + nodeId) % range. */
function allocRule(ports: string, ruleId: number, nodeId: number): number {
  const [start, end] = ports.split("-").map(Number);
  return start + ((ruleId * 31 + nodeId) % (end - start + 1));
}

describe("parseTargetAddress", () => {
  test("splits host:port, brackets IPv6, rejects junk", () => {
    expect(parseTargetAddress("web.example.org:443")).toEqual({ host: "web.example.org", port: 443 });
    expect(parseTargetAddress("[2001:db8::1]:8080")).toEqual({ host: "2001:db8::1", port: 8080 });
    expect(parseTargetAddress("no-port")).toBeNull();
    expect(parseTargetAddress("host:0")).toBeNull();
    expect(parseTargetAddress("host:99999")).toBeNull();
    expect(parseTargetAddress(":80")).toBeNull();
  });
});

describe("buildRealmNodeConfig", () => {
  test("single-node tunnel renders a direct forward", async () => {
    const db = makeDb();
    await seedBase(db);
    await db.insert(schema.tunnels).values({ id: 10, name: "single", forward_mode: "raw" });
    await db.insert(schema.chains).values({
      tunnel_id: 10,
      node_id: 1,
      chain_type: "in",
      transport: "raw",
      index: 0,
    });
    await db.insert(schema.relayRules).values({
      id: 100,
      name: "direct",
      listen_port: 16500,
      tunnel_id: 10,
      targets: "web.example.org:443",
    });

    const config = await buildRealmNodeConfig(db, 1);
    expect(config?.agent).toBe("realm");
    const svc = serviceOf(config!, "service-100");
    expect(svc).toMatchObject({
      listen_host: "0.0.0.0",
      listen_port: 16500,
      target_host: "web.example.org",
      target_port: 443,
      connect_timeout_s: 5,
    });
    expect(svc?.tls_side).toBeUndefined();
    expect(svc?.extra_targets).toBeUndefined();
    expect(config?.tls_material).toBeUndefined();
  });

  test("two-node tunnel: entry dials the exit's formula port, exit listens on it (legacy relay row included)", async () => {
    const db = makeDb();
    await seedBase(db);
    // forward_mode stays 'relay' — a legacy row that must render raw semantics anyway
    await seedTwoNodeTunnel(db, { tunnel: 20, inNode: 1, outNode: 2, rule: 200 });

    const entry = await buildRealmNodeConfig(db, 1);
    const exitPort = allocRule("30000-30100", 200, 2);
    expect(serviceOf(entry!, "service-200")).toMatchObject({
      listen_port: 16700,
      target_host: "10.0.0.2",
      target_port: exitPort,
    });

    const exit = await buildRealmNodeConfig(db, 2);
    expect(serviceOf(exit!, "service-200")).toMatchObject({
      listen_port: exitPort,
      target_host: "target.example.org",
      target_port: 443,
    });
  });

  test("explicit exit_port overrides the allocation on both ends", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 21, inNode: 1, outNode: 2, rule: 201 });
    await db.update(schema.relayRules).set({ exit_port: 34567 }).where(eq(schema.relayRules.id, 201));

    const entry = await buildRealmNodeConfig(db, 1);
    const exit = await buildRealmNodeConfig(db, 2);
    expect(serviceOf(entry!, "service-201")?.target_port).toBe(34567);
    expect(serviceOf(exit!, "service-201")?.listen_port).toBe(34567);
  });

  test("multiple out links form the LB candidate set with the in link's strategy", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 22, inNode: 1, outNode: 2, rule: 202 }, { inStrategy: "iphash" });
    await db.insert(schema.chains).values({
      tunnel_id: 22,
      node_id: 3,
      chain_type: "out",
      transport: "raw",
      index: 2,
    });

    const entry = await buildRealmNodeConfig(db, 1);
    const svc = serviceOf(entry!, "service-202");
    expect(svc?.target_host).toBe("10.0.0.2");
    expect(svc?.target_port).toBe(allocRule("30000-30100", 202, 2));
    expect(svc?.balance).toBe("iphash");
    expect(svc?.extra_targets).toEqual([{ host: "10.0.0.3", port: allocRule("31000-31100", 202, 3) }]);

    // every exit renders its own service under the same name
    const exitB = await buildRealmNodeConfig(db, 3);
    expect(serviceOf(exitB!, "service-202")).toMatchObject({
      listen_port: allocRule("31000-31100", 202, 3),
      target_host: "target.example.org",
    });
    expect(serviceOf(exitB!, "service-202")?.balance).toBeUndefined();
  });

  test("TLS tunnel: both legs marked, material attached, exit transport tls", async () => {
    const db = makeDb();
    await seedBase(db);
    await db.insert(schema.appSettings).values({ key: "tls_domain", value: "relay.example.test" });
    await seedTwoNodeTunnel(
      db,
      { tunnel: 23, inNode: 1, outNode: 2, rule: 203 },
      { tlsEnabled: true, outTransport: "tls" },
    );

    const entry = await buildRealmNodeConfig(db, 1);
    expect(serviceOf(entry!, "service-203")?.tls_side).toBe("connect");
    expect(entry?.tls_material?.sni).toBe("relay.example.test");
    expect(entry?.tls_material?.server_cert).toContain("BEGIN CERTIFICATE");

    const exit = await buildRealmNodeConfig(db, 2);
    expect(serviceOf(exit!, "service-203")?.tls_side).toBe("listen");
    expect(exit?.tls_material).toBeDefined();
  });

  test("tls_enabled with a non-tls transport degrades to plaintext", async () => {
    const db = makeDb();
    await seedBase(db);
    await db.insert(schema.appSettings).values({ key: "tls_domain", value: "relay.example.test" });
    // legacy grpc transport on the out link
    await seedTwoNodeTunnel(
      db,
      { tunnel: 24, inNode: 1, outNode: 2, rule: 204 },
      { tlsEnabled: true, outTransport: "grpc" },
    );

    const entry = await buildRealmNodeConfig(db, 1);
    expect(serviceOf(entry!, "service-204")?.tls_side).toBeUndefined();
    expect(entry?.tls_material).toBeUndefined();
  });

  test("multi-hop tunnels (chain rows) are skipped entirely", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 25, inNode: 1, outNode: 2, rule: 205 });
    await db.insert(schema.chains).values({
      tunnel_id: 25,
      node_id: 3,
      chain_type: "chain",
      transport: "raw",
      index: 1,
    });

    for (const nodeId of [1, 2, 3]) {
      const config = await buildRealmNodeConfig(db, nodeId);
      expect(serviceOf(config!, "service-205")).toBeUndefined();
    }
  });

  test("quota hard-stopped rules drop out of the payload", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 26, inNode: 1, outNode: 2, rule: 206 });
    // user-owned rule without an active subscription → applyRuleQuotas drops it
    await db.insert(schema.users).values({ id: 9, name: "u9", status: "active" });
    await db.update(schema.relayRules).set({ user_id: 9 }).where(eq(schema.relayRules.id, 206));

    const entry = await buildRealmNodeConfig(db, 1);
    expect(serviceOf(entry!, "service-206")).toBeUndefined();
  });

  test("unparsable targets skip the exit leg; the entry still dials the exit", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 27, inNode: 1, outNode: 2, rule: 207 });
    await db.update(schema.relayRules).set({ targets: "no-port-here" }).where(eq(schema.relayRules.id, 207));

    // The entry leg only dials the exit — a broken rule target cannot break it.
    const entry = await buildRealmNodeConfig(db, 1);
    expect(serviceOf(entry!, "service-207")).toBeDefined();
    // The exit leg forwards to the rule target and must not ship broken.
    const exit = await buildRealmNodeConfig(db, 2);
    expect(serviceOf(exit!, "service-207")).toBeUndefined();
  });

  test("missing node returns null", async () => {
    const db = makeDb();
    expect(await buildRealmNodeConfig(db, 99)).toBeNull();
  });
});

describe("recomputeNodeConfig", () => {
  test("bumps once on change and stays flat when identical", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 30, inNode: 1, outNode: 2, rule: 230 });

    const first = await recomputeNodeConfig(db, 1);
    expect(first).toEqual({ ok: true, changed: true });
    const again = await recomputeNodeConfig(db, 1);
    expect(again).toEqual({ ok: true, changed: false });

    await db.update(schema.relayRules).set({ targets: "other.example.org:80" }).where(eq(schema.relayRules.id, 230));
    const changed = await recomputeNodeConfig(db, 1);
    expect(changed).toEqual({ ok: true, changed: true });
  });

  test("missing node deletes the snapshot", async () => {
    const db = makeDb();
    const result = await recomputeNodeConfig(db, 42);
    expect(result).toEqual({ ok: false, changed: false });
  });
});

describe("nodeRuleTunnels (billing gate)", () => {
  test("OUT chains count regardless of the stored forward_mode", async () => {
    const db = makeDb();
    await seedBase(db);
    // legacy relay-mode row: its exit leg now deploys per-rule services
    await seedTwoNodeTunnel(db, { tunnel: 40, inNode: 1, outNode: 2, rule: 240 });

    const entryTunnels = await nodeRuleTunnels(db, 1);
    const exitTunnels = await nodeRuleTunnels(db, 2);
    expect(entryTunnels.has(40)).toBe(true);
    expect(exitTunnels.has(40)).toBe(true);

    // an unrelated node authorizes nothing
    const bystander = await nodeRuleTunnels(db, 3);
    expect(bystander.size).toBe(0);
  });
});

describe("quotaSweepStoppedUsers (flush-driven hard-stop sweep)", () => {
  const HOUR = "2026-08-29T10:00:00.000Z";

  async function seedPaidUser(db: AppDb, userId: number, trafficBytes: number): Promise<void> {
    await db.insert(schema.users).values({ id: userId, name: `u${userId}`, status: "active" });
    await db.insert(schema.packages).values({ id: userId, name: `pkg-${userId}`, traffic_bytes: trafficBytes });
    await db.insert(schema.userPackages).values({
      user_id: userId,
      package_id: userId,
      package_name: `pkg-${userId}`,
      traffic_bytes: trafficBytes,
      activated_at: "2026-08-01T00:00:00.000Z",
    });
  }

  async function snapshotWith(db: AppDb, nodeId: number, ruleIds: number[]): Promise<void> {
    const config = {
      agent: "realm",
      node: { id: nodeId, name: `n${nodeId}` },
      services: ruleIds.map((id) => ({
        name: `service-${id}`,
        listen_host: "0.0.0.0",
        listen_port: 16000 + id,
        target_host: "10.0.0.9",
        target_port: 80,
      })),
    };
    await db.insert(schema.nodeConfigs).values({ node_id: nodeId, version: 1, config_json: JSON.stringify(config) });
  }

  async function seedExhaustedRule(db: AppDb, ruleId: number, userId: number): Promise<void> {
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 50 + userId, inNode: 1, outNode: 2, rule: ruleId });
    await seedPaidUser(db, userId, 1000);
    await db.update(schema.relayRules).set({ user_id: userId }).where(eq(schema.relayRules.id, ruleId));
    // billed usage past the 1000-byte allowance
    await db.insert(schema.trafficHourly).values({
      rule_id: ruleId,
      user_id: userId,
      node_id: 1,
      hour_ts: HOUR,
      real_upload: 0,
      real_download: 0,
      billed_upload: 600,
      billed_download: 700,
    });
  }

  test("exhausted user with a still-deployed rule is swept", async () => {
    const db = makeDb();
    await seedExhaustedRule(db, 500, 9);
    // the rule is still deployed on BOTH ends
    await snapshotWith(db, 1, [500]);
    await snapshotWith(db, 2, [500]);

    expect(await quotaSweepStoppedUsers(db, [500])).toEqual([9]);
  });

  test("post-removal flushes short-circuit (rule no longer deployed)", async () => {
    const db = makeDb();
    await seedExhaustedRule(db, 501, 9);
    // the sweep already removed the service; a stale flush still reports it
    await snapshotWith(db, 1, []);

    expect(await quotaSweepStoppedUsers(db, [501])).toEqual([]);
  });

  test("below-allowance users are not swept", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 52, inNode: 1, outNode: 2, rule: 502 });
    await seedPaidUser(db, 8, 100_000);
    await db.update(schema.relayRules).set({ user_id: 8 }).where(eq(schema.relayRules.id, 502));
    await db.insert(schema.trafficHourly).values({
      rule_id: 502,
      user_id: 8,
      node_id: 1,
      hour_ts: HOUR,
      real_upload: 0,
      real_download: 0,
      billed_upload: 600,
      billed_download: 700,
    });
    await snapshotWith(db, 1, [502]);

    expect(await quotaSweepStoppedUsers(db, [502])).toEqual([]);
  });

  test("admin-owned rules are never swept", async () => {
    const db = makeDb();
    await seedBase(db);
    await seedTwoNodeTunnel(db, { tunnel: 53, inNode: 1, outNode: 2, rule: 503 });
    await snapshotWith(db, 1, [503]);

    expect(await quotaSweepStoppedUsers(db, [503])).toEqual([]);
  });
});
