import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { MIGRATION_DATABASE_URL_ENV } from "@/lib/db/connection";

/**
 * Seeds and removes synthetic fixtures in an isolated test database. Fixture
 * setup and cleanup need privileges (for example DELETE on evidence tables)
 * that the runtime read and write roles intentionally lack, so this client
 * uses the migration owner credential. It is test-only and must never be
 * imported by application code.
 */
export function createFixtureDatabase(): PrismaClient {
  const connectionString = process.env[MIGRATION_DATABASE_URL_ENV];
  if (!connectionString) {
    throw new Error(`${MIGRATION_DATABASE_URL_ENV} is required for database fixtures`);
  }

  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      application_name: "stellarcore-test-fixtures",
    }),
  });
}

/** Closes the runtime role clients that application code opened lazily. */
export async function disconnectRuntimeDatabases(): Promise<void> {
  const clients = globalThis as unknown as {
    stellarCoreReadDb?: PrismaClient;
    stellarCoreWriteDb?: PrismaClient;
  };
  await Promise.all([
    clients.stellarCoreReadDb?.$disconnect(),
    clients.stellarCoreWriteDb?.$disconnect(),
  ]);
}
