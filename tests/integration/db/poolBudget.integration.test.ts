/**
 * PostgreSQL pool budget integration tests.
 *
 * These tests require a live PostgreSQL instance accessible via DATABASE_URL.
 * They exercise:
 *
 * 1. Pool saturation and acquisition timeout with recovery
 * 2. Statement timeout with server-side cancellation and recovery
 * 3. Lock contention timeout with server-side cancellation and recovery
 * 4. No late side-effects after statement timeout/rollback
 * 5. Connection-count enforcement (pool never exceeds poolMax)
 *
 * All tests use an isolated `budget_test` schema, synthetic fixtures, and
 * generous bounded timing tolerances. No production credentials or data.
 *
 * Run with: tsx --test tests/integration/db/poolBudget.integration.test.ts
 *
 * Requires DATABASE_URL environment variable.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import pg from "pg";

import { createBudgetPool } from "@/lib/db/pool";
import { classifyDatabaseError } from "@/lib/db/errors";
import type { DatabaseBudgetConfig } from "@/lib/db/budgetConfig";

// ---------------------------------------------------------------------------
// Skip if no DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log("⏭ Skipping pool budget integration tests (no DATABASE_URL)");
  // Use test.skip to register a single skipped test for visibility.
  test.skip("poolBudget integration tests require DATABASE_URL", () => {});
} else {
  // All tests run inside this block only when DATABASE_URL is available.

  const TEST_SCHEMA = "budget_test";

  // Admin pool for setup/teardown (not budget-constrained).
  let adminPool: pg.Pool;

  before(async () => {
    adminPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.side_effects (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await adminPool.query(`TRUNCATE ${TEST_SCHEMA}.side_effects`);
  });

  after(async () => {
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await adminPool.end();
    }
  });

  // =========================================================================
  // 1. Pool saturation and acquisition timeout
  // =========================================================================

  describe("pool saturation", () => {
    test("excess acquisition fails within the configured timeout bound", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 1,
        acquisitionTimeoutMs: 500,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        transactionTimeoutMs: 20_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Occupy the single slot.
        const occupied = await pool.connect();

        const start = Date.now();
        try {
          // This should fail — the pool is full.
          const excess = await pool.connect();
          excess.release();
          assert.fail("Expected acquisition timeout");
        } catch (error) {
          const elapsed = Date.now() - start;
          // Should fail within ~500ms, generous tolerance ≤ 2000ms.
          assert.ok(elapsed < 2_000, `Acquisition took ${elapsed}ms, expected < 2000ms`);
          assert.equal(classifyDatabaseError(error), "POOL_ACQUISITION_TIMEOUT");
        }

        occupied.release();
      } finally {
        await pool.end();
      }
    });

    test("pool never exceeds configured connection cap", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 500,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        transactionTimeoutMs: 20_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        const client1 = await pool.connect();
        const client2 = await pool.connect();

        // With both slots occupied, pool.totalCount should be exactly 2.
        assert.equal(pool.totalCount, 2);

        // Third connection should fail.
        try {
          const client3 = await pool.connect();
          client3.release();
          assert.fail("Expected timeout for third connection");
        } catch {
          // Expected
        }

        // Total count must still be 2 — the cap was never exceeded.
        assert.ok(pool.totalCount <= 2, `Pool has ${pool.totalCount} connections, expected ≤ 2`);

        client1.release();
        client2.release();
      } finally {
        await pool.end();
      }
    });

    test("pool recovers and serves queries after saturation failure", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 1,
        acquisitionTimeoutMs: 500,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        transactionTimeoutMs: 20_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Occupy and release.
        const client = await pool.connect();
        try {
          await pool.connect();
          assert.fail("Should have timed out");
        } catch {
          // Expected timeout
        }
        client.release();

        // Pool should recover — this must succeed.
        const result = await pool.query("SELECT 1 AS value");
        assert.equal(result.rows[0]?.value, 1);
      } finally {
        await pool.end();
      }
    });
  });

  // =========================================================================
  // 2. Statement timeout with server-side cancellation
  // =========================================================================

  describe("statement timeout", () => {
    test("slow query is cancelled by server-side statement_timeout", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 1_000,   // 1 second — tight for test
        lockTimeoutMs: 500,
        transactionTimeoutMs: 5_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        const start = Date.now();
        try {
          // pg_sleep(10) would take 10 seconds — statement_timeout should cancel it.
          await pool.query("SELECT pg_sleep(10)");
          assert.fail("Expected statement timeout cancellation");
        } catch (error) {
          const elapsed = Date.now() - start;
          // Should be cancelled within ~1s, generous tolerance ≤ 3s.
          assert.ok(elapsed < 3_000, `Query ran for ${elapsed}ms, expected < 3000ms`);
          assert.equal(classifyDatabaseError(error), "STATEMENT_TIMEOUT");
        }
      } finally {
        await pool.end();
      }
    });

    test("pool serves reads after statement timeout failure", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 1_000,
        lockTimeoutMs: 500,
        transactionTimeoutMs: 5_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Cause a statement timeout.
        try {
          await pool.query("SELECT pg_sleep(10)");
        } catch {
          // Expected
        }

        // Pool must recover — a normal query must succeed.
        const result = await pool.query("SELECT 42 AS answer");
        assert.equal(result.rows[0]?.answer, 42);
      } finally {
        await pool.end();
      }
    });

    test("pool serves writes after statement timeout failure", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 1_000,
        lockTimeoutMs: 500,
        transactionTimeoutMs: 5_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Cause a statement timeout.
        try {
          await pool.query("SELECT pg_sleep(10)");
        } catch {
          // Expected
        }

        // Write must succeed after recovery.
        await pool.query(
          `INSERT INTO ${TEST_SCHEMA}.side_effects (value) VALUES ($1)`,
          ["recovery-write"],
        );
        const result = await pool.query(
          `SELECT value FROM ${TEST_SCHEMA}.side_effects WHERE value = $1`,
          ["recovery-write"],
        );
        assert.equal(result.rows[0]?.value, "recovery-write");
      } finally {
        await pool.end();
      }
    });
  });

  // =========================================================================
  // 3. Lock contention timeout
  // =========================================================================

  describe("lock contention timeout", () => {
    test("lock-blocked statement is cancelled by lock_timeout", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 500,          // 500ms lock timeout
        transactionTimeoutMs: 15_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Use advisory locks for deterministic lock contention.
        // Client A takes the lock.
        const clientA = await pool.connect();
        await clientA.query("SELECT pg_advisory_lock(12345)");

        // Client B tries to acquire the same lock — should be blocked
        // and cancelled by lock_timeout.
        const start = Date.now();
        try {
          const clientB = await pool.connect();
          try {
            await clientB.query("SELECT pg_advisory_lock(12345)");
            assert.fail("Expected lock timeout");
          } finally {
            clientB.release();
          }
        } catch (error) {
          const elapsed = Date.now() - start;
          // Should timeout within ~500ms, tolerance ≤ 3s.
          assert.ok(elapsed < 3_000, `Lock wait took ${elapsed}ms, expected < 3000ms`);
          const code = classifyDatabaseError(error);
          assert.ok(
            code === "LOCK_TIMEOUT" || code === "STATEMENT_TIMEOUT",
            `Expected LOCK_TIMEOUT or STATEMENT_TIMEOUT, got ${code}`,
          );
        }

        // Release the lock.
        await clientA.query("SELECT pg_advisory_unlock(12345)");
        clientA.release();
      } finally {
        await pool.end();
      }
    });

    test("pool recovers after lock contention timeout", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 500,
        transactionTimeoutMs: 15_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Cause a lock timeout.
        const holder = await pool.connect();
        await holder.query("SELECT pg_advisory_lock(99999)");

        try {
          const blocked = await pool.connect();
          try {
            await blocked.query("SELECT pg_advisory_lock(99999)");
          } catch {
            // Expected lock timeout
          } finally {
            blocked.release();
          }
        } catch {
          // Could be acquisition timeout if pool full
        }

        await holder.query("SELECT pg_advisory_unlock(99999)");
        holder.release();

        // Recovery: normal query must succeed.
        const result = await pool.query("SELECT 1 + 1 AS sum");
        assert.equal(result.rows[0]?.sum, 2);
      } finally {
        await pool.end();
      }
    });
  });

  // =========================================================================
  // 4. No late side effects after timeout/rollback
  // =========================================================================

  describe("no late side effects", () => {
    test("timed-out write in a transaction has no late side effect", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 2,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 1_000,
        lockTimeoutMs: 500,
        transactionTimeoutMs: 5_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Clear the table.
        await pool.query(`TRUNCATE ${TEST_SCHEMA}.side_effects`);

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Insert a row that we expect to be rolled back.
          await client.query(
            `INSERT INTO ${TEST_SCHEMA}.side_effects (value) VALUES ($1)`,
            ["should-not-exist"],
          );
          // Trigger statement timeout with pg_sleep inside the transaction.
          await client.query("SELECT pg_sleep(10)");
          // If we get here, the timeout didn't fire.
          await client.query("COMMIT");
          assert.fail("Expected statement timeout");
        } catch {
          // The transaction is now in a failed state; ROLLBACK.
          try {
            await client.query("ROLLBACK");
          } catch {
            // Connection might be in a bad state; that's OK.
          }
        } finally {
          client.release();
        }

        // Verify the row was NOT committed.
        const result = await pool.query(
          `SELECT COUNT(*) AS count FROM ${TEST_SCHEMA}.side_effects WHERE value = $1`,
          ["should-not-exist"],
        );
        assert.equal(Number(result.rows[0]?.count), 0, "Timed-out write must not persist");
      } finally {
        await pool.end();
      }
    });
  });

  // =========================================================================
  // 5. Session settings are applied (verification)
  // =========================================================================

  describe("session settings", () => {
    test("statement_timeout is set on new connections", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 1,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 7_777,
        lockTimeoutMs: 3_333,
        transactionTimeoutMs: 15_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        // Give the `connect` event handler a moment to run the SET.
        const client = await pool.connect();
        // Small delay to allow fire-and-forget SET to complete.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const result = await client.query("SHOW statement_timeout");
        const value = result.rows[0]?.statement_timeout;
        // PostgreSQL returns statement_timeout as a string like "7777ms" or "7s777ms".
        // We just check it contains "7777" or is approximately correct.
        assert.ok(
          value && (value.includes("7777") || value === "7777ms" || value === "7s777ms"),
          `Expected statement_timeout ≈ 7777ms, got "${value}"`,
        );
        client.release();
      } finally {
        await pool.end();
      }
    });

    test("lock_timeout is set on new connections", async () => {
      const config: DatabaseBudgetConfig = Object.freeze({
        poolMax: 1,
        acquisitionTimeoutMs: 5_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 7_777,
        lockTimeoutMs: 3_333,
        transactionTimeoutMs: 15_000,
      });
      const pool = createBudgetPool(DATABASE_URL!, config);

      try {
        const client = await pool.connect();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const result = await client.query("SHOW lock_timeout");
        const value = result.rows[0]?.lock_timeout;
        assert.ok(
          value && (value.includes("3333") || value === "3333ms" || value === "3s333ms"),
          `Expected lock_timeout ≈ 3333ms, got "${value}"`,
        );
        client.release();
      } finally {
        await pool.end();
      }
    });
  });
}
