/**
 * ingestTraffic regression tests against a real SQLite database (the D1
 * migration loaded into bun:sqlite) — the chunked multi-row upserts and the
 * CASE-based rule increments are plain-SQL semantics that only a database
 * round trip can verify: delta chaining across flushes, counter resets,
 * chunk-boundary splits, and the forged-service billing gate.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GostStatsSample } from "@tyz/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database as AppDb } from "../src/db";
import * as schema from "../src/db/schema";
import { ingestTraffic } from "../src/services/traffic";

function makeDb(): AppDb {
  const sqlite = new Database(":memory:");
  // Strip `--` comments, then split: fragments that are only comments would
  // otherwise be rejected as empty statements. Plain DDL, no triggers or
  // semicolons inside literals — naive split is safe.
  const migration = readFileSync(`${import.meta.dir}/../migrations/0001_init.sql`, "utf8");
  const ddl = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  for (const stmt of ddl.split(";")) {
    if (stmt.trim() !== "") sqlite.run(stmt);
  }
  // drizzle's d1 and bun-sqlite drivers share the query-builder runtime; the
  // type divergence is the only difference ingestTraffic never touches.
  return drizzle(sqlite, { schema }) as unknown as AppDb;
}

function sample(service: string, inputBytes: number, outputBytes: number, client = ""): GostStatsSample {
  return { service, client, totalConns: 1, currentConns: 1, inputBytes, outputBytes, totalErrs: 0 };
}

async function seed(db: AppDb, ruleCount: number): Promise<void> {
  await db.insert(schema.relayNodes).values({ id: 1, name: "n1", address: "127.0.0.1", token: "tok" });
  await db.insert(schema.tunnels).values({ id: 1, name: "t1" });
  await db
    .insert(schema.chains)
    .values({ id: 1, tunnel_id: 1, node_id: 1, chain_type: "in", transport: "raw", index: 0 });
  await db.insert(schema.relayRules).values(
    Array.from({ length: ruleCount }, (_, i) => ({
      id: i + 1,
      name: `rule-${i + 1}`,
      listen_port: 20000 + i,
      tunnel_id: 1,
      targets: "[]",
    })),
  );
}

describe("ingestTraffic", () => {
  test("chained deltas accumulate, resets re-anchor, client rows are skipped", async () => {
    const db = makeDb();
    await seed(db, 1);

    // First sighting: whole value counts.
    await ingestTraffic(db, 1, [sample("service-1", 1000, 2000), sample("service-t1", 500, 600)]);
    let hourly = await db.select().from(schema.trafficHourly);
    expect(hourly.length).toBe(1);
    expect(hourly[0]).toMatchObject({ rule_id: 1, real_upload: 1000, real_download: 2000 });
    let rule = await db.select().from(schema.relayRules);
    expect(rule[0]).toMatchObject({ upload_traffic: 1000, download_traffic: 2000 });
    const node = await db.select().from(schema.relayNodes);
    expect(node[0]).toMatchObject({ ingress_traffic: 1500, egress_traffic: 2600 }); // exit leg in node totals

    // Second flush: only the delta lands on the same (rule, hour) row.
    await ingestTraffic(db, 1, [sample("service-1", 3000, 5000)]);
    hourly = await db.select().from(schema.trafficHourly);
    expect(hourly.length).toBe(1);
    expect(hourly[0]).toMatchObject({ real_upload: 3000, real_download: 5000 });
    rule = await db.select().from(schema.relayRules);
    expect(rule[0]).toMatchObject({ upload_traffic: 3000, download_traffic: 5000 });

    // Counter reset (agent/service restart): cur < last contributes cur itself.
    await ingestTraffic(db, 1, [sample("service-1", 100, 200)]);
    hourly = await db.select().from(schema.trafficHourly);
    expect(hourly[0]).toMatchObject({ real_upload: 3100, real_download: 5200 });
    const counters = await db.select().from(schema.trafficCounters);
    expect(counters).toHaveLength(2);
    expect(counters.find((c) => c.service === "service-1")).toMatchObject({ upload: 100, download: 200 });
    expect(counters.find((c) => c.service === "service-t1")).toMatchObject({ upload: 500, download: 600 });

    // Per-client rows are breakdowns, never ledger input.
    await ingestTraffic(db, 1, [sample("service-1", 9999, 9999, "1.2.3.4:5")]);
    hourly = await db.select().from(schema.trafficHourly);
    expect(hourly[0]).toMatchObject({ real_upload: 3100, real_download: 5200 });
  });

  test("a flush larger than the chunk sizes splits without loss", async () => {
    const db = makeDb();
    // 22 rule services (hourly chunks at 12) + 2 shared exits (counters/metrics
    // chunks at 16) — every chunk boundary is crossed at least once.
    await seed(db, 22);
    await db.insert(schema.relayRules).values({ id: 23, name: "foreign", listen_port: 30000, targets: "[]" });

    const samples = [
      ...Array.from({ length: 22 }, (_, i) => sample(`service-${i + 1}`, 100 + i, 200 + i)),
      sample("service-t1", 1000, 1000),
      sample("service-t2", 2000, 2000),
      // Tunnel-less rule: a well-formed name the node does not serve — counts
      // toward node totals and counters, never the rule ledger.
      sample("service-23", 5000, 5000),
    ];
    await ingestTraffic(db, 1, samples);

    const hourly = await db.select().from(schema.trafficHourly);
    expect(hourly).toHaveLength(22); // shared exits and the foreign rule stay out of the ledger
    expect(hourly.reduce((a, r) => a + r.real_upload, 0)).toBe(22 * 100 + ((0 + 21) * 22) / 2);
    expect(hourly.find((r) => r.rule_id === 22)).toMatchObject({ real_upload: 121, real_download: 221 });

    const counters = await db.select().from(schema.trafficCounters);
    expect(counters).toHaveLength(25);

    const rules = await db.select().from(schema.relayRules);
    expect(rules.find((r) => r.id === 22)).toMatchObject({ upload_traffic: 121, download_traffic: 221 });
    expect(rules.find((r) => r.id === 23)).toMatchObject({ upload_traffic: 0, download_traffic: 0 });
    const node = await db.select().from(schema.relayNodes);
    expect(node[0]).toMatchObject({ ingress_traffic: 2431 + 1000 + 2000 + 5000 });

    const metrics = await db.select().from(schema.serviceMetricsHourly);
    expect(metrics).toHaveLength(25);
    expect(metrics.find((m) => m.service === "service-13")).toMatchObject({ samples: 1, conn_sum: 1, conn_max: 1 });
  });

  test("billed columns apply the node rate", async () => {
    const db = makeDb();
    await seed(db, 1);
    await db.update(schema.relayNodes).set({ rate: 0.5 });
    await ingestTraffic(db, 1, [sample("service-1", 1000, 2000)]);
    const hourly = await db.select().from(schema.trafficHourly);
    expect(hourly[0]).toMatchObject({ billed_upload: 500, billed_download: 1000 });
  });
});
