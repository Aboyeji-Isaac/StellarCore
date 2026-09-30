import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { assertEnvironmentIdentityOnce } from "@/lib/config/environmentGuard";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
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
 * Issue #143: fail-closed environment identity check on first database use.
 * Eagerly validated once per process; incompatible runtime/database pairings
 * reject the first operation with a bounded, secret-free error before any
 * evidence is read or mutated.
 */
export async function withEnvironmentIdentityGuard<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const guard = await assertEnvironmentIdentityOnce();
  if (!guard.ok) {
    throw new Error(guard.message ?? "environment identity check failed");
  }
  return operation();
}
