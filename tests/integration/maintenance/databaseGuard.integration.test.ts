import assert from "node:assert/strict";
import test from "node:test";

const ENABLED = process.env.RUN_MAINTENANCE_DATABASE_INTEGRATION === "1";

test("database write barrier closes the preflight-to-write maintenance race", {
  skip: !ENABLED,
}, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl);

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query('DELETE FROM "maintenance_state"');

    const triggerCount = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname LIKE 'maintenance_guard_%'
    `);
    assert.equal(Number(triggerCount.rows[0]?.count), 7);

    // Simulate an application preflight that sees maintenance clear.
    const preflight = await pool.query<{ active: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM "maintenance_state" WHERE "active" = true) AS active',
    );
    assert.equal(preflight.rows[0]?.active, false);

    // Maintenance activates after that preflight but before the worker's write.
    await pool.query(`
      INSERT INTO "maintenance_state"
        ("reason", "activated_by")
      VALUES
        ('Concurrent deployment freeze', 'integration-test')
    `);

    await assert.rejects(
      pool.query(`
        INSERT INTO "corridors"
          ("id", "asset_code_from", "country_from", "asset_code_to", "country_to", "slug")
        VALUES
          (gen_random_uuid(), 'USDC', 'US', 'TEST', 'ZZ', 'maintenance-race-test')
      `),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        return (
          candidate.code === "55000" &&
          candidate.message?.includes("STELLARCORE_MAINTENANCE_ACTIVE") === true
        );
      },
    );

    await pool.query(`
      UPDATE "maintenance_state"
      SET "active" = false,
          "deactivated_at" = NOW(),
          "deactivated_by" = 'integration-test'
      WHERE "active" = true
    `);

    await pool.query(`
      INSERT INTO "corridors"
        ("id", "asset_code_from", "country_from", "asset_code_to", "country_to", "slug")
      VALUES
        (gen_random_uuid(), 'USDC', 'US', 'TEST', 'ZZ', 'maintenance-race-test')
    `);
    const stored = await pool.query(
      'SELECT slug FROM "corridors" WHERE slug = $1',
      ["maintenance-race-test"],
    );
    assert.equal(stored.rowCount, 1);

    await pool.query(
      'DELETE FROM "corridors" WHERE slug = $1',
      ["maintenance-race-test"],
    );
  } finally {
    await pool.end();
  }
});
