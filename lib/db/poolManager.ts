import { Pool, type PoolConfig } from "pg";

import { isFailoverOrConnectionError } from "@/lib/db/failoverErrors";

export interface HardenedPoolOptions {
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly maxLifetimeSeconds: number;
  readonly keepAlive: boolean;
  readonly keepAliveInitialDelayMillis: number;
  readonly max: number;
}

const DEFAULT_POOL_OPTIONS: HardenedPoolOptions = Object.freeze({
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 1_800, // 30 minutes
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000, // 10 seconds
  max: 10,
});

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Resolves configuration for PostgreSQL connection pool with hardening defaults
 * to prevent hangs, resource leaks, and stale connection retention during failovers.
 */
export function resolveHardenedPoolOptions(
  overrides?: Partial<HardenedPoolOptions>,
): HardenedPoolOptions {
  return Object.freeze({
    connectionTimeoutMillis:
      overrides?.connectionTimeoutMillis ??
      parsePositiveInt(
        process.env.DB_CONNECTION_TIMEOUT_MS,
        DEFAULT_POOL_OPTIONS.connectionTimeoutMillis,
      ),
    idleTimeoutMillis:
      overrides?.idleTimeoutMillis ??
      parsePositiveInt(
        process.env.DB_IDLE_TIMEOUT_MS,
        DEFAULT_POOL_OPTIONS.idleTimeoutMillis,
      ),
    maxLifetimeSeconds:
      overrides?.maxLifetimeSeconds ??
      parsePositiveInt(
        process.env.DB_MAX_LIFETIME_SECONDS,
        DEFAULT_POOL_OPTIONS.maxLifetimeSeconds,
      ),
    keepAlive: overrides?.keepAlive ?? DEFAULT_POOL_OPTIONS.keepAlive,
    keepAliveInitialDelayMillis:
      overrides?.keepAliveInitialDelayMillis ??
      parsePositiveInt(
        process.env.DB_KEEP_ALIVE_INITIAL_DELAY_MS,
        DEFAULT_POOL_OPTIONS.keepAliveInitialDelayMillis,
      ),
    max:
      overrides?.max ??
      parsePositiveInt(
        process.env.DB_POOL_MAX,
        DEFAULT_POOL_OPTIONS.max,
      ),
  });
}

/**
 * Evicts all currently idle connections from a PostgreSQL pool.
 * Useful when a primary node fails over or shuts down, ensuring subsequent
 * requests do not attempt to reuse dead sockets.
 */
export function evictStalePoolConnections(pool: Pool): number {
  const internalPool = pool as unknown as {
    _idle?: Array<{ client: unknown }>;
    _remove?: (client: unknown) => void;
  };

  if (!Array.isArray(internalPool._idle) || typeof internalPool._remove !== "function") {
    return 0;
  }

  const idleItems = [...internalPool._idle];
  for (const item of idleItems) {
    try {
      internalPool._remove(item.client);
    } catch {
      // Safe no-op on individual removal errors
    }
  }

  return idleItems.length;
}

/**
 * Error handler for pool errors (such as background/idle client drops).
 */
export function handlePoolError(pool: Pool, error: unknown): void {
  if (isFailoverOrConnectionError(error)) {
    evictStalePoolConnections(pool);
  }
}

/**
 * Error handler for connection-level errors encountered by the adapter.
 */
export function handleConnectionError(pool: Pool, error: unknown): void {
  if (isFailoverOrConnectionError(error)) {
    evictStalePoolConnections(pool);
  }
}

/**
 * Creates and hardens a PostgreSQL connection pool with bounded timeouts,
 * TCP keepalive, lifetime recycling, and failover recovery handlers.
 */
export function createHardenedPool(
  connectionString: string,
  overrides?: Partial<HardenedPoolOptions>,
): Pool {
  const options = resolveHardenedPoolOptions(overrides);

  const poolConfig: PoolConfig = {
    connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis,
    maxLifetimeSeconds: options.maxLifetimeSeconds,
    keepAlive: options.keepAlive,
    keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis,
    max: options.max,
  };

  const pool = new Pool(poolConfig);

  // Prevent uncaught errors on idle clients from crashing the process
  pool.on("error", (error) => {
    handlePoolError(pool, error);
  });

  return pool;
}
