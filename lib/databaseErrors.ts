const TRANSIENT_DATABASE_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

export function isTransientDatabaseFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 6 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current !== "object") return false;
    const value = current as { code?: unknown; cause?: unknown; name?: unknown };
    if (typeof value.code === "string" && TRANSIENT_DATABASE_CODES.has(value.code)) return true;
    if (value.name === "PrismaClientInitializationError") return true;
    current = value.cause;
  }

  return false;
}
