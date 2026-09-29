import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "pg";

/**
 * Database-backed proof of rate-observation dispositions. Creates a throwaway
 * database, applies the migrations that precede dispositions, seeds legacy
 * synthetic snapshots, applies the disposition migration, then exercises the
 * operator tool, database guarantees, and read models. Drops the database.
 *
 * Opt-in: RUN_RATE_DISPOSITION_INTEGRATION=1 and DATABASE_TEST_ADMIN_URL, a
 * role with CREATEDB on an isolated PostgreSQL server.
 */
const ENABLED = process.env.RUN_RATE_DISPOSITION_INTEGRATION === "1";
const ADMIN_URL = process.env.DATABASE_TEST_ADMIN_URL;
const ROOT = resolve(import.meta.dirname, "../../..");
const PRISMA_CLI = createRequire(import.meta.url).resolve("prisma/build/index.js");
const DISPOSITION_MIGRATION = "20260929162952_add_rate_observation_dispositions";
const database = `stellarcore_dispositions_${randomBytes(6).toString("hex")}`;

type Ids = Record<string, string>;
const ids: Ids = {};
let databaseUrl = "";
let owner: Client;
let workspace = "";

function urlFor(name: string): string {
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  // Keep sessions in UTC so timestamptz values round-trip exactly.
  url.searchParams.set("options", "-c TimeZone=UTC");
  return url.href;
}

function migrate(migrationsPath: string): void {
  const config = join(workspace, `prisma.config.${randomBytes(3).toString("hex")}.mjs`);
  writeFileSync(config, [
    "export default {",
    `  schema: ${JSON.stringify(join(ROOT, "prisma/schema.prisma"))},`,
    `  migrations: { path: ${JSON.stringify(migrationsPath)} },`,
    "  datasource: { url: process.env.DATABASE_URL },",
    "};",
  ].join("\n"));
  const result = spawnSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--config", config], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  assert.equal(result.status, 0, "prisma migrate deploy failed");
}

async function snapshotRows(): Promise<Record<string, unknown>> {
  const rows = (await owner.query<{ id: string; value: unknown; xmin: string }>(
    "SELECT id, to_jsonb(snapshot) AS value, xmin::text FROM rate_snapshots AS snapshot ORDER BY id",
  )).rows;
  return Object.fromEntries(rows.map((row) => [row.id, { value: row.value, xmin: row.xmin }]));
}

async function insertSnapshot(key: string, anchor: string, corridor: string, secondsAgo: number): Promise<void> {
  ids[key] = (await owner.query<{ id: string }>(
    `INSERT INTO rate_snapshots (anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at)
     VALUES ($1, $2, 5.1, 100, 510, 0, now() - make_interval(secs => $3)) RETURNING id`,
    [ids[anchor], ids[corridor], secondsAgo],
  )).rows[0]!.id;
}

async function assertRejected(sql: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(owner.query(sql, params), (error: { code?: string }) => {
    assert.ok(["23514", "23001", "23505"].includes(error.code ?? ""), `unexpected ${error.code} for ${sql}`);
    return true;
  });
}

describe("rate observation dispositions", { skip: !ENABLED }, () => {
  let legacyBefore: Record<string, unknown>;

  before(async () => {
    assert.ok(ADMIN_URL, "DATABASE_TEST_ADMIN_URL is required");
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();
    databaseUrl = urlFor(database);

    workspace = mkdtempSync(join(tmpdir(), "stellarcore-dispositions-"));
    const previous = join(workspace, "previous-migrations");
    cpSync(join(ROOT, "prisma/migrations"), previous, { recursive: true });
    for (const entry of readdirSync(previous)) {
      if (entry >= DISPOSITION_MIGRATION && entry !== "migration_lock.toml") {
        rmSync(join(previous, entry), { recursive: true });
      }
    }
    migrate(previous);

    owner = new Client({ connectionString: databaseUrl });
    await owner.connect();
    for (const [key, slug] of [["anchorA", "anchor-a"], ["anchorB", "anchor-b"], ["anchorC", "anchor-c"]]) {
      ids[key!] = (await owner.query<{ id: string }>(
        `INSERT INTO anchors (slug, name, home_domain, toml_url, status, updated_at)
         VALUES ($1, $1, $2, $3, 'LIVE', now()) RETURNING id`,
        [slug, `${slug}.example.com`, `https://${slug}.example.com/.well-known/stellar.toml`],
      )).rows[0]!.id;
    }
    for (const [key, slug] of [["corridor1", "usdc-us-brl-br"], ["corridor2", "usdc-us-mxn-mx"]]) {
      ids[key!] = (await owner.query<{ id: string }>(
        `INSERT INTO corridors (slug, asset_code_from, country_from, asset_code_to, country_to)
         VALUES ($1, 'USDC', 'US', 'BRL', 'BR') RETURNING id`,
        [slug],
      )).rows[0]!.id;
    }
    for (const anchor of ["anchorA", "anchorB", "anchorC"]) {
      await owner.query("INSERT INTO anchor_corridors VALUES ($1, $2), ($1, $3)", [ids[anchor], ids.corridor1, ids.corridor2]);
    }
    // Legacy evidence captured before dispositions existed.
    await insertSnapshot("legacyA", "anchorA", "corridor1", 3_600);
    await insertSnapshot("aOld", "anchorA", "corridor1", 60);
    await insertSnapshot("aNew", "anchorA", "corridor1", 10);
    await insertSnapshot("b1", "anchorB", "corridor1", 20);
    await insertSnapshot("c1", "anchorC", "corridor1", 20);
    await insertSnapshot("bOtherCorridor", "anchorB", "corridor2", 5);
    legacyBefore = await snapshotRows();

    migrate(join(ROOT, "prisma/migrations"));
    process.env.DATABASE_URL = databaseUrl;
  });

  after(async () => {
    const clients = globalThis as unknown as { prisma?: { $disconnect: () => Promise<void> } };
    await clients.prisma?.$disconnect();
    await owner?.end();
    if (ADMIN_URL) {
      const admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("the migration backfills nothing and leaves legacy snapshots untouched and unreviewed", async () => {
    assert.deepEqual(await snapshotRows(), legacyBefore);
    const { rows } = await owner.query("SELECT count(*)::int AS count FROM rate_observation_dispositions");
    assert.equal(rows[0].count, 0);
    const { inspectSnapshot } = await import("@/lib/rates/dispositionTool");
    const inspection = await inspectSnapshot(ids.legacyA!);
    assert.equal(inspection.ok, true);
    if (inspection.ok) {
      assert.equal(inspection.snapshot.state, "active");
      assert.equal(inspection.snapshot.reviewed, false);
      assert.deepEqual(inspection.events, []);
    }
  });

  test("the operator tool enforces the state machine and records immutable events", async () => {
    const { runDisposition } = await import("@/lib/rates/dispositionTool");
    const base = { snapshotId: ids.legacyA, reviewReference: "GH-121", actor: "maintainer" };
    const quarantine = { ...base, action: "QUARANTINE", reasonCode: "SUSPECTED_INCORRECT_VALUE" };

    const dry = await runDisposition(quarantine, { apply: false });
    assert.equal(dry.ok && dry.mode, "dry-run");
    assert.equal((await owner.query("SELECT count(*)::int AS c FROM rate_observation_dispositions")).rows[0].c, 0);

    assert.equal((await runDisposition(quarantine, { apply: true })).ok, true);
    assert.deepEqual(await runDisposition(quarantine, { apply: true }), { ok: false, code: "ILLEGAL_TRANSITION" });
    const released = await runDisposition({ ...base, action: "RELEASE", reasonCode: "REVIEW_CLEARED" }, { apply: true });
    assert.equal(released.ok && released.toState, "active");
    const invalidated = await runDisposition(
      { ...base, action: "INVALIDATE", reasonCode: "SEMANTICALLY_INCORRECT", note: "value off by 10x" },
      { apply: true },
    );
    assert.equal(invalidated.ok && invalidated.sequence, 3);
    for (const action of ["QUARANTINE", "INVALIDATE", "RELEASE"]) {
      const reasonCode = { QUARANTINE: "SUSPECTED_INCORRECT_VALUE", INVALIDATE: "SOURCE_COMPROMISED", RELEASE: "REVIEW_CLEARED" }[action];
      assert.deepEqual(await runDisposition({ ...base, action, reasonCode }, { apply: true }), {
        ok: false,
        code: "ILLEGAL_TRANSITION",
      });
    }
    assert.deepEqual(
      await runDisposition({ ...quarantine, snapshotId: "00000000-0000-4000-8000-000000000000" }, { apply: true }),
      { ok: false, code: "SNAPSHOT_NOT_FOUND" },
    );
  });

  test("supersession rejects incompatible, older, missing, inactive, and cyclic replacements", async () => {
    const { runDisposition } = await import("@/lib/rates/dispositionTool");
    const supersede = (snapshotId: string, replacement: string) => runDisposition({
      action: "SUPERSEDE",
      snapshotId,
      supersededBySnapshotId: replacement,
      reasonCode: "NORMALIZATION_DEFECT",
      reviewReference: "GH-121",
      actor: "maintainer",
    }, { apply: true });

    assert.deepEqual(await supersede(ids.aOld!, ids.b1!), { ok: false, code: "INCOMPATIBLE_REPLACEMENT" });
    assert.deepEqual(await supersede(ids.b1!, ids.bOtherCorridor!), { ok: false, code: "INCOMPATIBLE_REPLACEMENT" });
    assert.deepEqual(await supersede(ids.aNew!, ids.aOld!), { ok: false, code: "REPLACEMENT_NOT_LATER" });
    assert.deepEqual(await supersede(ids.aOld!, "00000000-0000-4000-8000-000000000000"), {
      ok: false,
      code: "REPLACEMENT_NOT_FOUND",
    });
    assert.deepEqual(await supersede(ids.aOld!, ids.legacyA!), { ok: false, code: "REPLACEMENT_NOT_LATER" });

    const superseded = await supersede(ids.aOld!, ids.aNew!);
    assert.equal(superseded.ok && superseded.toState, "superseded");
    // The reverse link would form a cycle; it is rejected.
    const cycle = await supersede(ids.aNew!, ids.aOld!);
    assert.equal(cycle.ok, false);
    assert.ok(!cycle.ok && ["REPLACEMENT_NOT_LATER", "REPLACEMENT_NOT_ACTIVE"].includes(cycle.code));
  });

  test("the database itself rejects edits, deletes, truncation, and illegal inserts", async () => {
    await assertRejected("UPDATE rate_observation_dispositions SET note = 'rewritten'");
    await assertRejected("DELETE FROM rate_observation_dispositions");
    await assertRejected("TRUNCATE rate_observation_dispositions");
    const insert = `INSERT INTO rate_observation_dispositions
      (snapshot_id, sequence, action, reason_code, review_reference, actor, superseded_by_snapshot_id)
      VALUES ($1, $2, $3, $4, 'GH-121', 'raw-sql', $5)`;
    // Terminal state: legacyA is invalidated.
    await assertRejected(insert, [ids.legacyA, 4, "RELEASE", "REVIEW_CLEARED", null]);
    // Non-contiguous sequence.
    await assertRejected(insert, [ids.b1, 5, "QUARANTINE", "SUSPECTED_INCORRECT_VALUE", null]);
    // Reason code not allowed for the action.
    await assertRejected(insert, [ids.b1, 1, "INVALIDATE", "REVIEW_CLEARED", null]);
    // Cross-anchor supersession.
    await assertRejected(insert, [ids.b1, 1, "SUPERSEDE", "NORMALIZATION_DEFECT", ids.aNew]);
    // Duplicate sequence from a concurrent writer.
    await assertRejected(insert, [ids.aOld, 1, "QUARANTINE", "SUSPECTED_INCORRECT_VALUE", null]);
  });

  test("concurrent dispositions of one snapshot record exactly one event", async () => {
    const { runDisposition } = await import("@/lib/rates/dispositionTool");
    const input = {
      action: "QUARANTINE",
      snapshotId: ids.c1,
      reasonCode: "SUSPECTED_SOURCE_COMPROMISE",
      reviewReference: "GH-121",
      actor: "maintainer",
    };
    const results = await Promise.all([runDisposition(input, { apply: true }), runDisposition(input, { apply: true })]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const failed = results.find((result) => !result.ok);
    assert.ok(failed && !failed.ok && ["CONCURRENT_MODIFICATION", "ILLEGAL_TRANSITION"].includes(failed.code));
    const { rows } = await owner.query("SELECT count(*)::int AS c FROM rate_observation_dispositions WHERE snapshot_id = $1", [ids.c1]);
    assert.equal(rows[0].c, 1);
    await runDisposition({ ...input, action: "RELEASE", reasonCode: "REVIEW_CLEARED" }, { apply: true });
  });

  test("latest reads report the blocked newest observation and never promote an older one", async () => {
    const { runDisposition } = await import("@/lib/rates/dispositionTool");
    const { readLatestCorridorRate } = await import("@/lib/rates/latestRateReadModel");
    const invalidated = await runDisposition({
      action: "INVALIDATE",
      snapshotId: ids.aNew,
      reasonCode: "SOURCE_COMPROMISED",
      reviewReference: "GH-121",
      actor: "maintainer",
    }, { apply: true });
    assert.equal(invalidated.ok, true);

    const result = await readLatestCorridorRate("usdc-us-brl-br");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const anchorA = result.observations.filter(({ anchorSlug }) => anchorSlug === "anchor-a");
    assert.equal(anchorA.length, 1);
    assert.equal(anchorA[0]!.snapshotId, ids.aNew);
    assert.equal(anchorA[0]!.exclusionReason, "invalidated");
    assert.equal(anchorA[0]!.disposition?.reasonCode, "SOURCE_COMPROMISED");
    assert.equal(result.observations.some(({ snapshotId }) => snapshotId === ids.aOld || snapshotId === ids.legacyA), false);
    assert.equal(result.freshSourceCount, 2);

    // A newer, independently captured observation restores the anchor.
    await insertSnapshot("aNewest", "anchorA", "corridor1", 1);
    const restored = await readLatestCorridorRate("usdc-us-brl-br");
    assert.equal(restored.ok && restored.observations.find(({ anchorSlug }) => anchorSlug === "anchor-a")?.snapshotId, ids.aNewest);
    assert.equal(restored.ok && restored.freshSourceCount, 3);
  });

  test("the timeline keeps every point with its disposition", async () => {
    const { readRateObservationTimeline } = await import("@/lib/rates/observationTimeline");
    const timeline = await readRateObservationTimeline("usdc-us-brl-br", {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    });
    assert.equal(timeline.ok, true);
    if (!timeline.ok) return;
    const byId = new Map(timeline.points.map((point) => [point.snapshotId, point]));
    assert.equal(byId.size, 6);
    assert.equal(byId.get(ids.legacyA!)?.disposition?.state, "invalidated");
    assert.equal(byId.get(ids.aOld!)?.disposition?.state, "superseded");
    assert.equal(byId.get(ids.aNew!)?.usable, false);
    assert.equal(byId.get(ids.c1!)?.usable, true, "released from quarantine");
    const times = timeline.points.map(({ capturedAt }) => capturedAt);
    assert.deepEqual(times, [...times].sort());
  });

  test("future reputation evidence excludes blocked rates; persisted scores are not rewritten", async () => {
    const { rows: [score] } = await owner.query(
      `INSERT INTO reputation_scores (anchor_id, state, sample_size, computed_at)
       VALUES ($1, 'insufficient_data', 0, now() - interval '1 day') RETURNING to_jsonb(reputation_scores) AS value`,
      [ids.anchorB],
    );
    const { runDisposition } = await import("@/lib/rates/dispositionTool");
    await runDisposition({
      action: "INVALIDATE",
      snapshotId: ids.bOtherCorridor,
      reasonCode: "INVALID_CONFIGURATION",
      reviewReference: "GH-121",
      actor: "maintainer",
    }, { apply: true });

    const persisted = await owner.query(
      "SELECT to_jsonb(reputation_scores) AS value FROM reputation_scores WHERE anchor_id = $1",
      [ids.anchorB],
    );
    assert.deepEqual(persisted.rows[0].value, score.value, "dispositions never rewrite a persisted evaluation");

    const { PRISMA_REPUTATION_REPOSITORY } = await import("@/lib/reputation/repository");
    const evidence = await PRISMA_REPUTATION_REPOSITORY.readEvidence("anchor-b", new Date(0));
    assert.deepEqual(evidence?.latestRates.map(({ corridorSlug }) => corridorSlug), ["usdc-us-brl-br"]);
  });

  test("every original snapshot row is byte-for-byte unchanged after all dispositions", async () => {
    const after = await snapshotRows();
    for (const [id, row] of Object.entries(legacyBefore)) {
      assert.deepEqual(after[id], row, `snapshot ${id} changed`);
    }
    const { rows } = await owner.query("SELECT count(*)::int AS c FROM rate_observation_dispositions");
    assert.ok(rows[0].c >= 8);
  });
});
