import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import {
  createHardenedPool,
  evictStalePoolConnections,
  handleConnectionError,
  handlePoolError,
} from "@/lib/db/poolManager";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

export function validateDatabaseUrl(connectionString: string | undefined): string {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  let protocol: string;

  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  if (protocol === "prisma:" || protocol === "prisma+postgres:") {
    throw new Error(
      "DATABASE_URL must use postgres:// or postgresql:// with PrismaPg",
    );
  }

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  return connectionString;
}

function initializeDatabaseInstance(): {
  prisma: PrismaClient;
  pool: Pool;
} {
  const connectionString = validateDatabaseUrl(process.env.DATABASE_URL);
  const pool = createHardenedPool(connectionString);

  const adapter = new PrismaPg(pool, {
    onPoolError: (err) => handlePoolError(pool, err),
    onConnectionError: (err) => handleConnectionError(pool, err),
  });

  const prisma = new PrismaClient({ adapter });

  return { prisma, pool };
}

const activeInstance =
  globalForPrisma.prisma && globalForPrisma.pool
    ? { prisma: globalForPrisma.prisma, pool: globalForPrisma.pool }
    : initializeDatabaseInstance();

export const db: PrismaClient = activeInstance.prisma;

/**
 * Returns the underlying pg.Pool managing connections for PrismaPg.
 */
export function getDatabasePool(): Pool {
  return activeInstance.pool;
}

/**
 * Proactively evicts idle connections from the active pool.
 */
export function evictStaleConnections(): number {
  return evictStalePoolConnections(activeInstance.pool);
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = activeInstance.prisma;
  globalForPrisma.pool = activeInstance.pool;
}
