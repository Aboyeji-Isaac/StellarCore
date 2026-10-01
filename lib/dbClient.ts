import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
export type { PrismaClient };
import { assertDatabaseEnvironmentMatchesRuntime } from "@/lib/config/environmentGuardDb";
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from "@/lib/config/runtimeConfig";
import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";
import {
  createHardenedPool,
  evictStalePoolConnections,
  handleConnectionError,
  handlePoolError,
} from "@/lib/db/poolManager";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
  prismaEnvironmentVerified: Promise<void> | undefined;
};

/**
 * Validates a DATABASE_URL value.
 * Exported for testing and external validation.
 */
export function validateDatabaseUrl(
  connectionString: string | undefined,
): string {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  let protocol: string;

  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  }

  if (protocol === "prisma:" || protocol === "prisma+postgres:") {
    throw new Error(
      "DATABASE_URL must use postgres:// or postgresql:// with PrismaPg",
    );
  }

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must use postgres:// or postgresql://",
    );
  }

  return connectionString;
}

function createPrismaClient(
  config: RuntimeConfig = getRuntimeConfig(),
): PrismaClient {
  const connectionString = validateDatabaseUrl(config.databaseUrl);

  const tls = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: connectionString,
    environmentId: config.environment,
    environment: process.env,
  });

  if (!tls.resolution.accepted) {
    const { code, message } = tls.resolution.rejection;

    throw new Error(
      `Database TLS policy failure (${code}): ${message}`,
    );
  }

  if (tls.emergencyBypassActive) {
    console.warn(
      "[stellarcore:database] emergency TLS verification bypass active",
    );
  }

  const pool = createHardenedPool(
    tls.sanitizedConnectionString,
    undefined,
    tls.resolution.mode === "DISABLED"
      ? undefined
      : tls.resolution.sslConfig,
  );

  const adapter = new PrismaPg(pool, {
    onPoolError: (error) => handlePoolError(pool, error),
    onConnectionError: (error) =>
      handleConnectionError(pool, error),
  });

  // Store pool for global access in non-production
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pool = pool;
  }

  return new PrismaClient({ adapter });
}

const activeInstance =
  globalForPrisma.prisma
    ? {
        prisma: globalForPrisma.prisma,
        pool: globalForPrisma.pool,
      }
    : (() => {
        const client = createPrismaClient();

        return {
          prisma: client,
          pool: globalForPrisma.pool,
        };
      })();

export const db: PrismaClient = activeInstance.prisma;

/** Returns the underlying hardened pg.Pool used by PrismaPg. */
export function getDatabasePool(): Pool | undefined {
  return globalForPrisma.pool;
}

/** Proactively evicts currently idle pooled connections after a failover signal. */
export function evictStaleConnections(): number {
  const pool = globalForPrisma.pool;

  if (!pool) return 0;

  return evictStalePoolConnections(pool);
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = activeInstance.prisma;
}

/**
 * Environment isolation verification (#143).
 *
 * Callers MUST await `ensureDatabaseEnvironment()` once before the first
 * evidence read or write. It verifies the durable database_environment stamp
 * against the declared runtime identity and fails closed with a bounded,
 * secret-free error on any mismatch, missing stamp, or missing runtime
 * identity. Verification is cached per process after a successful pass.
 */
export async function ensureDatabaseEnvironment(): Promise<void> {
  globalForPrisma.prismaEnvironmentVerified ??= (async () => {
    await assertDatabaseEnvironmentMatchesRuntime(db);
  })();

  await globalForPrisma.prismaEnvironmentVerified;
}

/** Test hook: clears the cached verification so guard tests can re-run it. */
export function resetDatabaseEnvironmentForTests(): void {
  globalForPrisma.prismaEnvironmentVerified = undefined;
}

/** Test hook: allows injecting a test runtime configuration. */
export function setRuntimeConfigForTests(
  config: RuntimeConfig,
): void {
  globalForPrisma.prisma = createPrismaClient(config);
}

/** Test hook: clears the cached runtime configuration. */
export function resetRuntimeConfigForTests(): void {
  globalForPrisma.prisma = undefined;
}