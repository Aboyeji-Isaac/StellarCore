import type { PrismaClient } from "@/app/generated/prisma/client";

import {
  EnvironmentIsolationError,
  isDatabaseEnvironmentId,
  resolveRuntimeEnvironment,
  verifyEnvironmentPairing,
  type DatabaseEnvironmentId,
} from "@/lib/config/environmentGuard";

/**
 * Database-backed environment verification (#143).
 *
 * Reads the durable database_environment stamp (see migration
 * 20260929000000_add_database_environment) and verifies it against the
 * declared runtime identity. Verification runs before first evidence access
 * and is cached per process after a pass; a failure always throws the bounded,
 * secret-free EnvironmentIsolationError.
 *
 * The stamp table is read with raw SQL on purpose: verification must work
 * even though the stamp table is intentionally absent from the Prisma schema
 * (it is deployment metadata, not evidence).
 */

export type VerifiedEnvironment = Readonly<{
  runtimeEnvironment: DatabaseEnvironmentId;
  databaseEnvironment: DatabaseEnvironmentId;
}>;

const globalForEnvironmentGuard = globalThis as unknown as {
  stellarCoreVerifiedEnvironment?: VerifiedEnvironment;
};

export async function assertDatabaseEnvironmentMatchesRuntime(
  client: Pick<PrismaClient, "$queryRaw">,
): Promise<VerifiedEnvironment> {
  const cached = globalForEnvironmentGuard.stellarCoreVerifiedEnvironment;
  if (cached) return cached;

  const runtime = resolveRuntimeEnvironment();
  if (!runtime.ok) {
    throw new EnvironmentIsolationError(
      runtime.code,
      null,
      null,
    );
  }

  const stamp = await readDatabaseEnvironmentStamp(client);
  const verdict = verifyEnvironmentPairing(runtime.environment, stamp);
  if (!verdict.ok) {
    throw new EnvironmentIsolationError(
      verdict.code,
      verdict.runtimeEnvironment,
      verdict.databaseEnvironment,
    );
  }

  const verified: VerifiedEnvironment = Object.freeze({
    runtimeEnvironment: runtime.environment,
    databaseEnvironment: verdict.environment,
  });
  globalForEnvironmentGuard.stellarCoreVerifiedEnvironment = verified;
  return verified;
}

export function resetEnvironmentGuardCacheForTests(): void {
  globalForEnvironmentGuard.stellarCoreVerifiedEnvironment = undefined;
}

async function readDatabaseEnvironmentStamp(
  client: Pick<PrismaClient, "$queryRaw">,
): Promise<string | null> {
  try {
    const rows = await client.$queryRaw<{ environment: string }[]>`
      SELECT "environment" FROM "database_environment" WHERE "id" = 1
    `;
    const [row] = rows;
    if (!row) return null;
    return isDatabaseEnvironmentId(row.environment) ? row.environment : row.environment;
  } catch (error) {
    // A missing stamp table means the database was never stamped: fail closed
    // rather than silently allowing. Surface as DATABASE_STAMP_MISSING.
    if (isMissingRelationError(error)) {
      throw new EnvironmentIsolationError("DATABASE_STAMP_MISSING", null, null);
    }
    throw error;
  }
}

function isMissingRelationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
}
