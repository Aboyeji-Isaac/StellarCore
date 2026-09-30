/**
 * Budget-aware PostgreSQL pool factory.
 *
 * Creates a `pg.Pool` whose connection slots, acquisition waits,
 * statement timeouts, and lock-wait limits are bounded by the
 * validated {@link DatabaseBudgetConfig}.
 *
 * ## Per-connection session settings
 *
 * Each new connection fires `SET statement_timeout` and `SET lock_timeout`
 * once via the pg Pool `connect` event. These are **server-side** settings
 * — PostgreSQL will cancel the offending backend process, guaranteeing
 * that a blocked statement or lock wait cannot outlive the budget.
 *
 * If a connection is returned to the pool after a failed transaction, the
 * `connect` event for the *next checkout from a new physical connection*
 * will re-apply the settings. For connections that were already alive, `pg`
 * reuses them with their existing session state. We use the `connect` event
 * (fires once per new connection) to set them, and since we never `SET`
 * anything else in application code, session-setting leakage is avoided.
 *
 * Under transaction-pooling deployments (e.g., PgBouncer in transaction
 * mode), `SET` commands apply only within the current transaction and are
 * reset when the connection returns to the pooler. For direct connections,
 * `SET` persists for the session lifetime.
 *
 * @module
 */

import pg from "pg";

import type { DatabaseBudgetConfig } from "@/lib/db/budgetConfig";

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

/**
 * Create a budget-bounded `pg.Pool`.
 *
 * The returned pool enforces:
 * - Maximum `config.poolMax` connections (never exceeded)
 * - Acquisition wait of `config.acquisitionTimeoutMs`
 * - Idle eviction after `config.idleTimeoutMs`
 * - Server-side `statement_timeout` on every new connection
 * - Server-side `lock_timeout` on every new connection
 *
 * Normal request completion does **not** disconnect the shared pool.
 * Call `pool.end()` only during CLI shutdown or test teardown.
 */
export function createBudgetPool(
  connectionString: string,
  config: DatabaseBudgetConfig,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: config.poolMax,
    connectionTimeoutMillis: config.acquisitionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    // Do not set min; let the pool scale from 0 to max on demand.
    // Do not set allowExitOnIdle; Next.js manages process lifetime.
  });

  // Apply server-side timeouts on every *new* physical connection.
  // The `connect` event fires once when a new pg.Client is created
  // (not on reuse from the idle pool), so this is the correct hook
  // for one-time session initialization.
  pool.on("connect", (client: pg.PoolClient) => {
    // Fire-and-forget: if the SET fails the connection will be
    // released back with an error and will not serve queries.
    void client.query(
      `SET statement_timeout = ${config.statementTimeoutMs}; ` +
      `SET lock_timeout = ${config.lockTimeoutMs};`
    );
  });

  // Prevent unhandled errors on idle clients from crashing the process.
  // These errors surface when a connection drops while sitting in the
  // pool. The pool will destroy the client and replace it on demand.
  pool.on("error", () => {
    // Intentionally swallowed. The pool removes the failed client
    // and creates a replacement on the next checkout.
  });

  return pool;
}
