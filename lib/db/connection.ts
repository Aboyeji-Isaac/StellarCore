/**
 * Bounded Prisma/pg connection construction.
 *
 * One pool is created per runtime role per process. Pools are never created per
 * request. The bounds are applied at three layers, and each layer owns a
 * different guarantee:
 *
 * - `max` bounds pool size. `connectionTimeoutMillis` bounds both waiting for a
 *   free pool slot and establishing a new physical connection (verified against
 *   the installed `pg-pool` implementation).
 * - `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`
 *   are sent as PostgreSQL startup parameters, so they are enforced by the
 *   server for every statement on every pooled connection. PostgreSQL cancels
 *   the statement and aborts the transaction; the connection is not abandoned
 *   client-side.
 * - `$transaction` `timeout`/`maxWait` are a client-side backstop for
 *   interactive transactions, used together with the server-side limits.
 *
 * `query_timeout` is intentionally not set: node-postgres implements it as a
 * client-side abandonment, which is not sufficient for a mutation. Server-side
 * `statement_timeout` is the authoritative statement bound.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import type { DatabaseBudget } from "@/lib/db/budget";
import { toDatabaseResourceError, type DatabaseResourceError } from "@/lib/db/errors";

export type BoundedDatabaseClient = Readonly<{
  role: string;
  budget: DatabaseBudget;
  pool: Pool;
  client: PrismaClient;
}>;

export type CreateBoundedDatabaseClientOptions = Readonly<{
  role: string;
  connectionString: string;
  budget: DatabaseBudget;
  onPoolError?: (error: DatabaseResourceError) => void;
}>;

/**
 * Builds one bounded pool and Prisma client. `disposeExternalPool` is enabled so
 * explicit `$disconnect()` (CLI/scripts) drains this pool; request handlers must
 * never call `$disconnect()` on the shared runtime client.
 */
export function createBoundedDatabaseClient(
  options: CreateBoundedDatabaseClientOptions,
): BoundedDatabaseClient {
  const { budget } = options;

  const pool = new Pool(buildPoolConfig(options.connectionString, budget));

  const handleError = (error: unknown): void => {
    // The listener must never throw and must never forward a raw driver error.
    options.onPoolError?.(toDatabaseResourceError(error));
  };

  const adapter = new PrismaPg(pool, {
    disposeExternalPool: true,
    onPoolError: (error) => handleError(error),
    onConnectionError: (error) => handleError(error),
  });

  const client = new PrismaClient({ adapter });

  return Object.freeze({
    role: options.role,
    budget,
    pool,
    client,
  });
}

export function buildPoolConfig(
  connectionString: string,
  budget: DatabaseBudget,
): PoolConfig {
  return {
    connectionString,
    max: budget.poolMax,
    connectionTimeoutMillis: budget.connectionTimeoutMs,
    idleTimeoutMillis: budget.idleTimeoutMs,
    maxLifetimeSeconds: budget.maxLifetimeSeconds,
    allowExitOnIdle: false,
    application_name: budget.applicationName,
    statement_timeout: budget.statementTimeoutMs,
    lock_timeout: budget.lockTimeoutMs,
    idle_in_transaction_session_timeout: budget.idleInTransactionTimeoutMs,
  };
}

export type DatabasePoolSnapshot = Readonly<{
  total: number;
  idle: number;
  waiting: number;
  max: number | null;
}>;

/** Read-only pool counters, used by diagnostics and saturation tests. */
export function describeDatabasePool(pool: Pool): DatabasePoolSnapshot {
  return Object.freeze({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: typeof pool.options.max === "number" ? pool.options.max : null,
  });
}
