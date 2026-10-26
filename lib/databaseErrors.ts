import { isFailoverOrConnectionError } from "@/lib/db/failoverErrors";

const PRISMA_TRANSIENT_DATABASE_CODES = new Set([
  "P1001", // cannot reach database server
  "P1002", // database server reached but timed out
  "P1008", // operations timed out
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
  "P2037", // too many database connections opened
  "53300", // PostgreSQL too_many_connections
]);

type NestedDatabaseError = Readonly<{
  code?: unknown;
  cause?: unknown;
  originalError?: unknown;
  driverError?: unknown;
}>;

/**
 * Returns true only for database availability/failover conditions where serving
 * a recent verified stale snapshot is safer than fabricating a fresh result.
 *
 * Generic Prisma initialization failures are deliberately not treated as
 * transient because they may represent persistent configuration/authentication
 * errors that must fail closed.
 */
export function isTransientDatabaseFailure(error: unknown): boolean {
  if (isFailoverOrConnectionError(error)) return true;

  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current !== "object") return false;

    const value = current as NestedDatabaseError;
    if (
      typeof value.code === "string"
      && PRISMA_TRANSIENT_DATABASE_CODES.has(value.code)
    ) {
      return true;
    }

    current =
      value.cause
      ?? value.originalError
      ?? value.driverError
      ?? null;
  }

  return false;
}
