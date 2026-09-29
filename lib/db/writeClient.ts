import type { PrismaClient } from "@/app/generated/prisma/client";
import { createRuntimePrismaClient } from "@/lib/db/connection";

/**
 * Internal writer boundary for approved mutation paths only: scheduled
 * refresh, registry bootstrap, rate persistence, and reputation persistence.
 * It connects with DATABASE_WRITE_URL, whose PostgreSQL role holds the
 * reviewed DML grants in lib/db/grants.ts and owns no schema objects.
 * Public code must not import this module; eslint.config.mjs and
 * tests/unit/db/importBoundaries.test.ts enforce that.
 */
const globalForWriteDb = globalThis as unknown as {
  stellarCoreWriteDb: PrismaClient | undefined;
};

export const writeDb =
  globalForWriteDb.stellarCoreWriteDb ?? createRuntimePrismaClient("write");

if (process.env.NODE_ENV !== "production") {
  globalForWriteDb.stellarCoreWriteDb = writeDb;
}
