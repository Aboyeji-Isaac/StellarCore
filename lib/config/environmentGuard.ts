import {
  checkEnvironmentIdentity,
  describeEnvironmentIdentityFailure,
  isRuntimeEnvironment,
  resolveRuntimeIdentity,
  type DatabaseIdentity,
  type RuntimeIdentity,
} from "@/lib/config/environment";

/**
 * Durable database identity check (issue #143).
 *
 * Reads the single `environment_identity` row and fails closed when the
 * runtime environment cannot operate on this database. Runs at first database
 * access (lib/dbClient) and is reusable by cron/bootstrap/migration paths so
 * every write boundary enforces the same pairing rule.
 *
 * The identity row is read with raw SQL through the pg adapter; a missing
 * table (fresh database before migrations) fails closed as unmarked.
 */
export async function readDatabaseIdentity(): Promise<DatabaseIdentity> {
  const { db } = await import("@/lib/dbClient");
  try {
    const rows = await db.$queryRaw<{ environment: string | null; marked_at: Date | null }[]>`
      SELECT environment, marked_at FROM environment_identity WHERE id = 1`;
    const row = rows[0];
    const environment = row?.environment ?? null;
    return Object.freeze({
      // Treat any unexpected stored value as unknown (fail closed).
      environment: isRuntimeEnvironment(environment) ? environment : null,
      markedAt: row?.marked_at ? new Date(row.marked_at.getTime()) : null,
    });
  } catch {
    // Table missing or unreadable: identity unknown -> fail closed.
    return Object.freeze({ environment: null, markedAt: null });
  }
}

export type EnvironmentGuardResult = Readonly<{
  ok: boolean;
  code?: string;
  message?: string;
  runtime: RuntimeIdentity;
}>;

/**
 * Full guard: resolve runtime identity, read the durable database identity,
 * and verify the pairing. Throws EnvironmentIdentityError only for runtime
 * declaration problems; pairing failures return a bounded typed result so
 * callers can produce secret-free 500s or abort scripts.
 */
export async function assertEnvironmentIdentity(): Promise<EnvironmentGuardResult> {
  const runtime = resolveRuntimeIdentity();
  const database = await readDatabaseIdentity();
  const check = checkEnvironmentIdentity(runtime, database);
  if (!check.ok) {
    return Object.freeze({
      ok: false,
      code: check.code,
      message: describeEnvironmentIdentityFailure(check),
      runtime,
    });
  }
  return Object.freeze({ ok: true, runtime });
}

/**
 * One shared memo per process: the durable check runs once and its result is
 * reused, so per-request guards never add per-request database round trips.
 */
let cachedGuard: Promise<EnvironmentGuardResult> | undefined;

export function assertEnvironmentIdentityOnce(): Promise<EnvironmentGuardResult> {
  cachedGuard ??= assertEnvironmentIdentity().catch((error) => {
    cachedGuard = undefined;
    throw error;
  });
  return cachedGuard;
}

/** Test-only reset for the process-wide memo. */
export function resetEnvironmentIdentityCache(): void {
  cachedGuard = undefined;
}
