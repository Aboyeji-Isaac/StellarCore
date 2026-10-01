import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";

export type { PrismaClient };
import { assertDatabaseEnvironmentMatchesRuntime } from "@/lib/config/environmentGuardDb";
import { getRuntimeConfig, type RuntimeConfig } from "@/lib/config/runtimeConfig";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaEnvironmentVerified: Promise<void> | undefined;
};

function createPrismaClient(config: RuntimeConfig = getRuntimeConfig()): PrismaClient {
  const adapter = new PrismaPg({ connectionString: config.databaseUrl });
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

/** Test hook: allows injecting a test runtime configuration. */
export function setRuntimeConfigForTests(config: RuntimeConfig): void {
  globalForPrisma.prisma = createPrismaClient(config);
}

/** Test hook: clears the cached runtime configuration. */
export function resetRuntimeConfigForTests(): void {
  globalForPrisma.prisma = undefined;
}