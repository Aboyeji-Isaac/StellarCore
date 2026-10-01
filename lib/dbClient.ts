import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";

export type { PrismaClient };
import { assertDatabaseEnvironmentMatchesRuntime } from "@/lib/config/environmentGuardDb";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaEnvironmentVerified: Promise<void> | undefined;
};

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

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

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
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
