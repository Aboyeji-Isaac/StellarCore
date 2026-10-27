export type DatabaseErrorClassification =
  | "FAILOVER_OR_CONNECTION"
  | "TRANSACTION_RESOLUTION_UNKNOWN"
  | "QUERY_FAILURE"
  | "UNKNOWN";

const CONNECTION_ERROR_CODES = new Set([
  // Node / OS Network Errors
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  // PostgreSQL SQLState Class 08: Connection Exceptions
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  // PostgreSQL SQLState Class 57P: Operator Intervention
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  // Primary Demotion / Read-only standby
  "25006", // read_only_sql_transaction
]);

const AMBIGUOUS_TRANSACTION_CODES = new Set([
  "08007", // transaction_resolution_unknown
]);

const QUERY_FAILURE_PREFIXES = [
  "23", // Class 23: Integrity Constraint Violation (23505 unique_violation, etc.)
  "42", // Class 42: Syntax Error or Access Rule Violation (42P01 undefined_table, etc.)
  "22", // Class 22: Data Exception (22P02 invalid_text_representation, etc.)
  "40", // Class 40: Transaction Rollback (40001 serialization_failure, 40P01 deadlock - owned by #200)
];

const CONNECTION_ERROR_MESSAGES = [
  /connection.*terminated/i,
  /connection.*closed/i,
  /connection.*reset/i,
  /client has encountered a connection error/i,
  /terminating connection due to administrator command/i,
  /the database system is in recovery mode/i,
  /the database system is shutting down/i,
  /the database system is starting up/i,
  /server closed the connection unexpectedly/i,
  /could not connect to server/i,
  /timeout exceeded when trying to connect/i,
  /Connection terminated due to connection timeout/i,
];

interface NestedErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  originalError?: unknown;
  driverError?: unknown;
}

function extractAllErrorCodesAndMessages(error: unknown): {
  codes: string[];
  messages: string[];
} {
  const codes: string[] = [];
  const messages: string[] = [];
  const visited = new Set<unknown>();

  let current: unknown = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const err = current as NestedErrorLike;

    if (typeof err.code === "string") {
      codes.push(err.code);
    }
    if (typeof err.message === "string") {
      messages.push(err.message);
    }

    // Traverse potential nested error properties
    if (err.cause) {
      current = err.cause;
    } else if (err.originalError) {
      current = err.originalError;
    } else if (err.driverError) {
      current = err.driverError;
    } else {
      break;
    }
  }

  return { codes, messages };
}

/**
 * Checks whether an error signifies an ambiguous transaction commit resolution.
 * If true, the transaction may or may not have committed on the primary.
 */
export function isTransactionResolutionUnknown(error: unknown): boolean {
  if (!error) return false;
  const { codes, messages } = extractAllErrorCodesAndMessages(error);

  for (const code of codes) {
    if (AMBIGUOUS_TRANSACTION_CODES.has(code)) {
      return true;
    }
  }

  for (const msg of messages) {
    if (/transaction resolution unknown/i.test(msg)) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a database error is caused by a connection failure, network disruption,
 * server termination, or primary failover/demotion.
 *
 * Connection/failover errors should trigger connection pool eviction and reconnect recovery.
 * Normal query failures (e.g. unique constraint or syntax errors) return false.
 */
export function isFailoverOrConnectionError(error: unknown): boolean {
  if (!error) return false;
  const { codes, messages } = extractAllErrorCodesAndMessages(error);

  // Check known connection codes
  for (const code of codes) {
    if (CONNECTION_ERROR_CODES.has(code) || AMBIGUOUS_TRANSACTION_CODES.has(code)) {
      return true;
    }
  }

  // Check connection error message patterns
  for (const msg of messages) {
    for (const pattern of CONNECTION_ERROR_MESSAGES) {
      if (pattern.test(msg)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Classifies an unknown error into a structured classification.
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorClassification {
  if (!error) return "UNKNOWN";

  if (isTransactionResolutionUnknown(error)) {
    return "TRANSACTION_RESOLUTION_UNKNOWN";
  }

  if (isFailoverOrConnectionError(error)) {
    return "FAILOVER_OR_CONNECTION";
  }

  const { codes } = extractAllErrorCodesAndMessages(error);
  for (const code of codes) {
    for (const prefix of QUERY_FAILURE_PREFIXES) {
      if (code.startsWith(prefix)) {
        return "QUERY_FAILURE";
      }
    }
  }

  return "UNKNOWN";
}
