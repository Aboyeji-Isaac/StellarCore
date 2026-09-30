import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Pool } from "pg";

const MIGRATION_INTEGRATION_ENABLED = process.env.RUN_MIGRATION_DATABASE_INTEGRATION === "1";

test("decimal outcome migration preserves, rejects, rolls back, and re-forwards representative rows", {
  skip: !MIGRATION_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const initialSql = await readFile(join(
      process.cwd(),
      "prisma/migrations/20260818140749_init/migration.sql",
    ), "utf8");
    const forwardSql = await readFile(join(
      process.cwd(),
      "prisma/migrations/20260930120000_exact_transfer_outcome_decimals/migration.sql",
    ), "utf8");
    const rollbackSql = await readFile(join(
      process.cwd(),
      "prisma/migrations/20260930120000_exact_transfer_outcome_decimals/rollback.sql",
    ), "utf8");
    await client.query(initialSql);

    const anchor = await client.query<{ id: string }>(
      `INSERT INTO "anchors" ("slug", "name", "home_domain", "toml_url")
       VALUES ('migration-test', 'Migration Test', 'migration.example',
         'https://migration.example/.well-known/stellar.toml') RETURNING "id"`,
    );
    const corridor = await client.query<{ id: string }>(
      `INSERT INTO "corridors" ("asset_code_from", "country_from", "asset_code_to", "country_to", "slug")
       VALUES ('USD', 'US', 'BRL', 'BR', 'migration-corridor') RETURNING "id"`,
    );
    await client.query(
      `INSERT INTO "transfer_outcomes" ("anchor_id", "corridor_id", "status", "fill_rate", "settlement_ms", "slippage")
       VALUES ('${anchor.rows[0]!.id}', '${corridor.rows[0]!.id}', 'COMPLETED',
         0.123456789012345678::double precision, 1000,
         -0.123456789012345678::double precision)`,
    );
    await client.query(
      `INSERT INTO "transfer_outcomes" ("anchor_id", "corridor_id", "status", "fill_rate", "settlement_ms", "slippage")
       VALUES ('${anchor.rows[0]!.id}', '${corridor.rows[0]!.id}', 'ERROR', 1.2, 1000, 0)`,
    );
    await client.query(
      `INSERT INTO "reputation_scores" ("anchor_id", "fill_rate_7d", "fill_rate_30d", "fill_rate_90d", "slippage_p50", "slippage_p95")
       VALUES ('${anchor.rows[0]!.id}', 0.333333, 0.666667, 1,
         0.123456789012345678::double precision,
         -0.123456789012345678::double precision)`,
    );

    await assert.rejects(client.query(forwardSql), /outside \[0,1\]/);
    const oldType = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'transfer_outcomes' AND column_name = 'fill_rate'`,
    );
    assert.equal(oldType.rows[0]?.data_type, "double precision");
    await client.query(`DELETE FROM "transfer_outcomes" WHERE "status" = 'ERROR'`);

    await client.query(forwardSql);
    await assertForwardValues(client);
    await client.query(rollbackSql);
    const rolledBackType = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'transfer_outcomes' AND column_name = 'fill_rate'`,
    );
    assert.equal(rolledBackType.rows[0]?.data_type, "double precision");
    await client.query(forwardSql);
    await assertForwardValues(client);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});

async function assertForwardValues(client: import("pg").PoolClient): Promise<void> {
  const outcomes = await client.query<{
    fill_rate: string;
    slippage: string;
  }>(`SELECT "fill_rate"::text AS fill_rate, "slippage"::text AS slippage FROM "transfer_outcomes"`);
  assert.equal(outcomes.rows[0]?.fill_rate, "0.123456789012345680");
  assert.equal(outcomes.rows[0]?.slippage, "-0.123456789012345680");

  const scores = await client.query<{
    fill_rate_7d: string;
    fill_rate_30d: string;
    slippage_p50: string;
  }>(`SELECT "fill_rate_7d"::text AS fill_rate_7d,
      "fill_rate_30d"::text AS fill_rate_30d,
      "slippage_p50"::text AS slippage_p50 FROM "reputation_scores"`);
  assert.equal(scores.rows[0]?.fill_rate_7d, "0.3333");
  assert.equal(scores.rows[0]?.fill_rate_30d, "0.6667");
  assert.equal(scores.rows[0]?.slippage_p50, "0.123456789012345680");
}