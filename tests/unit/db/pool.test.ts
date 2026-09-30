import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createBudgetPool } from "@/lib/db/pool";
import { DATABASE_BUDGET_DEFAULTS, type DatabaseBudgetConfig } from "@/lib/db/budgetConfig";

// ---------------------------------------------------------------------------
// createBudgetPool — structural tests (no live database)
// ---------------------------------------------------------------------------

describe("createBudgetPool", () => {
  const FAKE_URL = "postgresql://user:pass@localhost:5432/testdb";

  test("creates a pool with configured max connections", () => {
    const config: DatabaseBudgetConfig = { ...DATABASE_BUDGET_DEFAULTS, poolMax: 3 };
    const pool = createBudgetPool(FAKE_URL, config);
    try {
      // pg.Pool exposes `options.max`
      assert.equal((pool as unknown as { options: { max: number } }).options.max, 3);
    } finally {
      void pool.end();
    }
  });

  test("creates a pool with configured acquisition timeout", () => {
    const config: DatabaseBudgetConfig = { ...DATABASE_BUDGET_DEFAULTS, acquisitionTimeoutMs: 2_000 };
    const pool = createBudgetPool(FAKE_URL, config);
    try {
      const options = (pool as unknown as { options: { connectionTimeoutMillis: number } }).options;
      assert.equal(options.connectionTimeoutMillis, 2_000);
    } finally {
      void pool.end();
    }
  });

  test("creates a pool with configured idle timeout", () => {
    const config: DatabaseBudgetConfig = { ...DATABASE_BUDGET_DEFAULTS, idleTimeoutMs: 30_000 };
    const pool = createBudgetPool(FAKE_URL, config);
    try {
      const options = (pool as unknown as { options: { idleTimeoutMillis: number } }).options;
      assert.equal(options.idleTimeoutMillis, 30_000);
    } finally {
      void pool.end();
    }
  });

  test("pool is an instance of pg.Pool", async () => {
    const { default: pg } = await import("pg");
    const pool = createBudgetPool(FAKE_URL, DATABASE_BUDGET_DEFAULTS);
    try {
      assert.ok(pool instanceof pg.Pool);
    } finally {
      void pool.end();
    }
  });

  test("pool emits no unhandled error when error handler is attached", () => {
    const pool = createBudgetPool(FAKE_URL, DATABASE_BUDGET_DEFAULTS);
    // Verify the error handler is attached (listenerCount > 0)
    assert.ok(pool.listenerCount("error") >= 1);
    void pool.end();
  });

  test("pool has connect listener for session settings", () => {
    const pool = createBudgetPool(FAKE_URL, DATABASE_BUDGET_DEFAULTS);
    assert.ok(pool.listenerCount("connect") >= 1);
    void pool.end();
  });
});
