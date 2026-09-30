/**
 * Secret-free database error translation.
 *
 * Translates raw driver/pool errors into bounded, safe application errors
 * that **never** expose connection strings, SQL, database host/user details,
 * or raw driver messages in the public API response.
 *
 * The application API handlers already return generic `internal_error`
 * responses (see `lib/api/rates.ts`, `lib/api/anchors.ts`). This module
 * provides classification so that **logged** messages can distinguish
 * pool exhaustion from statement timeouts without leaking secrets into
 * the HTTP response body.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Classifiable database failure codes, safe for logs and metrics.
 * These codes never appear in public API responses — the API handlers
 * map all database errors to their existing `internal_error` code.
 */
export type DatabaseErrorCode =
  | "POOL_ACQUISITION_TIMEOUT"
  | "STATEMENT_TIMEOUT"
  | "LOCK_TIMEOUT"
  | "CONNECTION_LOST"
  | "TRANSACTION_TIMEOUT"
  | "DATABASE_ERROR";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * An application-level database error with no secret information.
 *
 * Instances carry a classified {@link code} for internal diagnostics
 * and a generic user-facing {@link safeMessage} that is free of SQL,
 * connection strings, host names, or driver internals.
 */
export class DatabaseBudgetError extends Error {
  readonly code: DatabaseErrorCode;
  readonly safeMessage: string;

  constructor(code: DatabaseErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "DatabaseBudgetError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a raw error from the pg driver or Prisma into a safe
 * {@link DatabaseErrorCode}. The classification uses well-known
 * PostgreSQL error codes and pg Pool error patterns documented in
 * node-postgres and Prisma sources.
 *
 * References:
 * - PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
 * - node-postgres Pool: https://node-postgres.com/apis/pool
 * - Prisma error reference: https://www.prisma.io/docs/reference/api-reference/error-reference
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorCode {
  if (!(error instanceof Error)) return "DATABASE_ERROR";

  const message = error.message ?? "";

  // PostgreSQL error codes embedded in the error object.
  const pgCode = extractPgCode(error);

  if (pgCode) {
    // 57014 = query_canceled (statement_timeout or manual cancel)
    if (pgCode === "57014") {
      // Distinguish lock_timeout from statement_timeout by message content.
      if (/lock timeout/i.test(message)) {
        return "LOCK_TIMEOUT";
      }
      return "STATEMENT_TIMEOUT";
    }

    // 55P03 = lock_not_available (lock_timeout with NOWAIT or lock_timeout)
    if (pgCode === "55P03") {
      return "LOCK_TIMEOUT";
    }

    // 08xxx = connection exceptions
    if (pgCode.startsWith("08")) {
      return "CONNECTION_LOST";
    }
  }

  // Lock timeout by message even without SQLSTATE
  if (/lock timeout/i.test(message) || /could not obtain lock/i.test(message)) {
    return "LOCK_TIMEOUT";
  }

  // Statement timeout by message even without SQLSTATE
  if (/statement timeout/i.test(message)) {
    return "STATEMENT_TIMEOUT";
  }

  // pg Pool: "Timed out while waiting for available connection" or similar
  // This fires when connectionTimeoutMillis is exceeded.
  if (
    /(time-?out|timed\s*out).*waiting.*(connection|client)/i.test(message) ||
    /(time-?out|timed\s*out).*trying to (connect|acquire)/i.test(message) ||
    /connection.*(time-?out|timed\s*out)/i.test(message) ||
    /(time-?out|timed\s*out).*connection/i.test(message) ||
    /pool.*exhaust/i.test(message)
  ) {
    return "POOL_ACQUISITION_TIMEOUT";
  }

  // Prisma interactive transaction timeout (P2028)
  if (/P2028/i.test(message) || /transaction.*(time-?out|timed\s*out)/i.test(message)) {
    return "TRANSACTION_TIMEOUT";
  }

  // Connection termination patterns
  if (
    /connection terminated/i.test(message) ||
    /ECONNRESET/i.test(message) ||
    /connection.*closed/i.test(message)
  ) {
    return "CONNECTION_LOST";
  }

  return "DATABASE_ERROR";
}

/**
 * Wrap a raw error as a safe {@link DatabaseBudgetError} with no secrets.
 */
export function toSafeDatabaseError(error: unknown): DatabaseBudgetError {
  const code = classifyDatabaseError(error);
  return new DatabaseBudgetError(code, SAFE_MESSAGES[code]);
}

// ---------------------------------------------------------------------------
// Safe messages (no secrets)
// ---------------------------------------------------------------------------

const SAFE_MESSAGES: Readonly<Record<DatabaseErrorCode, string>> = Object.freeze({
  POOL_ACQUISITION_TIMEOUT: "Database pool is temporarily exhausted.",
  STATEMENT_TIMEOUT: "A database query exceeded its time limit.",
  LOCK_TIMEOUT: "A database operation was blocked by a concurrent lock.",
  CONNECTION_LOST: "Database connection was lost.",
  TRANSACTION_TIMEOUT: "A database transaction exceeded its time limit.",
  DATABASE_ERROR: "An unexpected database error occurred.",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract PostgreSQL error code from various error shapes.
 * node-postgres errors carry a `code` property with the SQLSTATE.
 */
function extractPgCode(error: Error): string | undefined {
  const asRecord = error as unknown as Record<string, unknown>;
  if (typeof asRecord["code"] === "string" && /^[0-9A-Z]{5}$/.test(asRecord["code"])) {
    return asRecord["code"];
  }
  return undefined;
}
