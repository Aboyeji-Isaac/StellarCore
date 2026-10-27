import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { deriveLockKey, lockName } from "@/lib/scheduled/advisoryLockKey";

const databaseEnabled =
  process.env.RUN_DATABASE_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

async function unlock(client: PoolClient, key: bigint): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
}

test(
  "real PostgreSQL same-key contention is non-blocking and preserves exclusion",
  { skip: !databaseEnabled },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const first = await pool.connect();
    const second = await pool.connect();
    const key = deriveLockKey(
      lockName("refresh", "advisory-lock-integration", "v1", randomUUID()),
    );

    try {
      const firstResult = await first.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key.toString()],
      );
      assert.equal(firstResult.rows[0]?.acquired, true);

      const secondResult = await second.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key.toString()],
      );
      assert.equal(secondResult.rows[0]?.acquired, false);

      await unlock(first, key);

      const retryResult = await second.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key.toString()],
      );
      assert.equal(retryResult.rows[0]?.acquired, true);
      await unlock(second, key);
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  },
);

test(
  "real PostgreSQL versioned keys are independent and therefore require explicit coexistence policy",
  { skip: !databaseEnabled },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const first = await pool.connect();
    const second = await pool.connect();
    const resource = randomUUID();
    const v1 = deriveLockKey(lockName("refresh", "version-safety", "v1", resource));
    const v2 = deriveLockKey(lockName("refresh", "version-safety", "v2", resource));

    assert.notEqual(v1, v2);

    try {
      const firstResult = await first.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [v1.toString()],
      );
      const secondResult = await second.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [v2.toString()],
      );

      assert.equal(firstResult.rows[0]?.acquired, true);
      assert.equal(secondResult.rows[0]?.acquired, true);

      await unlock(first, v1);
      await unlock(second, v2);
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  },
);
