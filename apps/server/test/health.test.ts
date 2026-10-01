/**
 * ingestHealthSnapshot regression tests against a real SQLite database (the
 * D1 migration loaded into bun:sqlite): the sentinel liveness row, snapshot
 * upsert + diff-delete (including the empty-world cleanup), and the
 * tunnel-authorized rule status write-back.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RelayRuleStatus, type ServiceHealthSample } from "@tyz/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database as AppDb } from "../src/db";
import * as schema from "../src/db/schema";
import { HEARTBEAT_SERVICE, ingestHealthSnapshot } from "../src/services/health";

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
  return drizzle(sqlite, { schema }) as unknown as AppDb;
}

function health(service: string, state: string, error?: string): ServiceHealthSample {
  return { service, state, ...(error ? { error } : {}) };
}

async function seed(db: AppDb): Promise<void> {
  // Node 1 serves tunnel 1 (in-chain); node 2 serves tunnel 2. Rule 1 belongs
  // to tunnel 1 (authorized for node 1), rule 2 to tunnel 2 (NOT authorized).
  await db.insert(schema.relayNodes).values([
    { id: 1, name: "n1", address: "127.0.0.1", token: "tok-1" },
    { id: 2, name: "n2", address: "127.0.0.2", token: "tok-2" },
  ]);
  await db.insert(schema.tunnels).values([
    { id: 1, name: "t1" },
    { id: 2, name: "t2" },
  ]);
  await db.insert(schema.chains).values([
    { id: 1, tunnel_id: 1, node_id: 1, chain_type: "in", transport: "raw", index: 0 },
    { id: 2, tunnel_id: 2, node_id: 2, chain_type: "in", transport: "raw", index: 0 },
  ]);
  await db.insert(schema.relayRules).values([
    { id: 1, name: "rule-1", listen_port: 20001, tunnel_id: 1, targets: "[]" },
    {
      id: 2,
      name: "rule-2",
      listen_port: 20002,
      tunnel_id: 2,
      targets: "[]",
      status: RelayRuleStatus.PAUSED,
    },
  ]);
}

const T0 = "2026-10-02T00:00:00.000Z";
const T1 = "2026-10-02T00:01:00.000Z";

async function serviceRow(db: AppDb, service: string) {
  const [row] = await db.select().from(schema.serviceHealth).where(eq(schema.serviceHealth.service, service));
  return row;
}

async function rule(db: AppDb, id: number) {
  const [row] = await db.select().from(schema.relayRules).where(eq(schema.relayRules.id, id));
  return row;
}

describe("ingestHealthSnapshot", () => {
  test("stamps the sentinel, upserts services, keeps the sentinel on diff", async () => {
    const db = makeDb();
    await seed(db);

    await ingestHealthSnapshot(db, 1, [health("service-1", "ready")], T0);
    const sentinel = await serviceRow(db, HEARTBEAT_SERVICE);
    expect(sentinel).toMatchObject({ node_id: 1, state: "ready", reported_at: T0 });
    expect(await serviceRow(db, "service-1")).toMatchObject({ state: "ready", reported_at: T0 });

    // Second beat: new timestamp, changed state; the sentinel survives the
    // diff (it is always treated as reported).
    await ingestHealthSnapshot(db, 1, [health("service-1", "failed", "bind: EADDRINUSE")], T1);
    expect(await serviceRow(db, HEARTBEAT_SERVICE)).toMatchObject({ reported_at: T1 });
    expect(await serviceRow(db, "service-1")).toMatchObject({
      state: "failed",
      error: "bind: EADDRINUSE",
      reported_at: T1,
    });
  });

  test("snapshot removals diff-delete; an empty snapshot clears everything but the sentinel", async () => {
    const db = makeDb();
    await seed(db);

    await ingestHealthSnapshot(db, 1, [health("service-1", "ready"), health("service-2", "ready")], T0);
    await ingestHealthSnapshot(db, 1, [health("service-2", "ready")], T1);
    expect(await serviceRow(db, "service-1")).toBeUndefined();
    expect(await serviceRow(db, "service-2")).toBeDefined();

    // Empty world: everything real goes, the sentinel stays.
    await ingestHealthSnapshot(db, 1, [], T1);
    const rows = await db.select().from(schema.serviceHealth);
    expect(rows.map((r) => r.service)).toEqual([HEARTBEAT_SERVICE]);
  });

  test("rule status write-back is tunnel-authorized and never touches paused", async () => {
    const db = makeDb();
    await seed(db);

    // Both rules' services appear in node 1's snapshot, but only rule 1's
    // tunnel is served by node 1: rule 2 must keep its manual `paused`.
    await ingestHealthSnapshot(db, 1, [health("service-1", "ready"), health("service-2", "failed")], T0);
    expect(await rule(db, 1)).toMatchObject({ status: RelayRuleStatus.RUNNING });
    expect(await rule(db, 2)).toMatchObject({ status: RelayRuleStatus.PAUSED });

    // Failure flips rule 1 to error; recovery flips it back.
    await ingestHealthSnapshot(db, 1, [health("service-1", "apply_failed")], T1);
    expect(await rule(db, 1)).toMatchObject({ status: RelayRuleStatus.ERROR });
    await ingestHealthSnapshot(db, 1, [health("service-1", "running")], T1);
    expect(await rule(db, 1)).toMatchObject({ status: RelayRuleStatus.RUNNING });

    // A service name that isn't a per-rule entry service is ignored.
    await ingestHealthSnapshot(db, 1, [health("service-t1", "ready")], T1);
    expect(await rule(db, 1)).toMatchObject({ status: RelayRuleStatus.RUNNING });
  });
});
