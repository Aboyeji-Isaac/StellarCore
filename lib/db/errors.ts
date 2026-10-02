/**
 * Classifies database resource-exhaustion failures into bounded, secret-free
 * application errors.
 *
 * Raw driver and server messages can contain connection strings, SQL, database
 * hosts, users, or parameters. This module never returns or logs those values;
 * it maps internal signals (SQLSTATE, Node errno, Prisma error code, or a small
 * set of known timeout phrases) to a fixed public code and a static message.
 */

export type DatabaseFailureCode =
  | "database_connection_failure"
  | "database_connection_timeout"
  | "database_idle_transaction_timeout"
  | "database_lock_timeout"
  | "database_pool_timeout"
  | "database_statement_timeout"
  | "database_too_many_connections"
  | "database_transaction_timeout"
  | "database_unrecognized_failure";

export type DatabaseFailureClassification = Readonly<{
  code: DatabaseFailureCode;
  /** Whether a fresh attempt could plausibly succeed. Never auto-retried. */
  retryable: boolean;
  /** True when a known signal matched; false for an unclassified failure. */
  recognized: boolean;
}>;

export class DatabaseResourceError extends Error {
  readonly code: DatabaseFailureCode;
  readonly retryable: boolean;
  readonly recognized: boolean;

  constructor(classification: DatabaseFailureClassification) {
    super(SAFE_MESSAGES[classification.code]);
    this.name = "DatabaseResourceError";
    this.code = classification.code;
    this.retryable = classification.retryable;
    this.recognized = classification.recognized;
  }
}

const SAFE_MESSAGES: Readonly<Record<DatabaseFailureCode, string>> = Object.freeze({
  database_connection_failure: "The database connection failed.",
  database_connection_timeout: "Establishing a database connection timed out.",
  database_idle_transaction_timeout: "An idle database transaction timed out.",
  database_lock_timeout: "A database lock could not be acquired in time.",
  database_pool_timeout: "The database connection pool is exhausted.",
  database_statement_timeout: "A database statement exceeded its time budget.",
  database_too_many_connections: "The database rejected the connection.",
  database_transaction_timeout: "A database transaction exceeded its time budget.",
  database_unrecognized_failure: "The database operation failed.",
});

const CLASSIFICATION: Readonly<Record<DatabaseFailureCode, Omit<DatabaseFailureClassification, "code">>> =
  Object.freeze({
    database_connection_failure: { retryable: true, recognized: true },
    database_connection_timeout: { retryable: true, recognized: true },
    database_idle_transaction_timeout: { retryable: false, recognized: true },
    database_lock_timeout: { retryable: true, recognized: true },
    database_pool_timeout: { retryable: true, recognized: true },
    database_statement_timeout: { retryable: false, recognized: true },
    database_too_many_connections: { retryable: true, recognized: true },
    database_transaction_timeout: { retryable: false, recognized: true },
    database_unrecognized_failure: { retryable: false, recognized: false },
  });

const SQLSTATE_CLASSIFICATION: Readonly<Record<string, DatabaseFailureCode>> = Object.freeze({
  "57014": "database_statement_timeout",
  "55P03": "database_lock_timeout",
  "25P03": "database_idle_transaction_timeout",
  "53300": "database_too_many_connections",
  "53400": "database_pool_timeout",
  "08000": "database_connection_failure",
  "08001": "database_connection_failure",
  "08003": "database_connection_failure",
  "08004": "database_connection_failure",
  "08006": "database_connection_failure",
  "08007": "database_connection_failure",
  "08101": "database_connection_failure",
  "57P01": "database_connection_failure",
  "57P02": "database_connection_failure",
  "57P03": "database_connection_failure",
});

const NODE_ERRNO_CLASSIFICATION: Readonly<Record<string, DatabaseFailureCode>> = Object.freeze({
  ECONNREFUSED: "database_connection_failure",
  ECONNRESET: "database_connection_failure",
  EHOSTUNREACH: "database_connection_failure",
  ENETUNREACH: "database_connection_failure",
  ENOTFOUND: "database_connection_failure",
  EPIPE: "database_connection_failure",
  ETIMEDOUT: "database_connection_timeout",
});

const PRISMA_CODE_CLASSIFICATION: Readonly<Record<string, DatabaseFailureCode>> = Object.freeze({
  P1001: "database_connection_failure",
  P1002: "database_connection_timeout",
  P1008: "database_connection_timeout",
  P1017: "database_connection_failure",
  P2024: "database_pool_timeout",
  P2028: "database_transaction_timeout",
});

const TIMEOUT_PHRASES: readonly Readonly<{ phrase: string; code: DatabaseFailureCode }>[] =
  Object.freeze([
    Object.freeze({ phrase: "timeout exceeded when trying to connect", code: "database_pool_timeout" }),
    Object.freeze({ phrase: "Connection terminated due to connection timeout", code: "database_connection_timeout" }),
    Object.freeze({ phrase: "timeout acquiring a connection", code: "database_pool_timeout" }),
    Object.freeze({ phrase: "connection pool is full", code: "database_pool_timeout" }),
    Object.freeze({ phrase: "Pool is full", code: "database_pool_timeout" }),
    Object.freeze({ phrase: "too many clients already", code: "database_too_many_connections" }),
  ]);

const MAX_TRAVERSAL_DEPTH = 6;
const MAX_TRAVERSAL_NODES = 200;
const MAX_ARRAY_ITEMS = 10;
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Inspects an error and its wrapped causes without exposing any raw value.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseFailureClassification {
  const signals = collectSignals(error);

  for (const code of signals.codes) {
    const sqlState = SQLSTATE_CLASSIFICATION[code];
    if (sqlState) return classify(sqlState);
  }

  for (const code of signals.codes) {
    const errno = NODE_ERRNO_CLASSIFICATION[code];
    if (errno) return classify(errno);
  }

  for (const code of signals.codes) {
    const prismaCode = PRISMA_CODE_CLASSIFICATION[code];
    if (prismaCode) return classify(prismaCode);
  }

  for (const message of signals.messages) {
    for (const { phrase, code } of TIMEOUT_PHRASES) {
      if (message.includes(phrase)) return classify(code);
    }
  }

  return classify("database_unrecognized_failure");
}

/** Wraps any error in a `DatabaseResourceError` with a safe message. */
export function toDatabaseResourceError(error: unknown): DatabaseResourceError {
  return new DatabaseResourceError(classifyDatabaseFailure(error));
}

/** Convenience predicate used by the runtime pool error listeners. */
export function isRecognizedResourceFailure(error: unknown): boolean {
  return classifyDatabaseFailure(error).recognized;
}

function classify(code: DatabaseFailureCode): DatabaseFailureClassification {
  return Object.freeze({ code, ...CLASSIFICATION[code] });
}

type CollectedSignals = Readonly<{
  codes: readonly string[];
  messages: readonly string[];
}>;

function collectSignals(error: unknown): CollectedSignals {
  const codes = new Set<string>();
  const messages: string[] = [];
  const visited = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  let visitedNodes = 0;

  while (queue.length > 0 && visitedNodes < MAX_TRAVERSAL_NODES) {
    const next = queue.shift();
    if (!next || next.depth > MAX_TRAVERSAL_DEPTH) continue;
    const { value, depth } = next;

    if (typeof value === "string") {
      if (value.length > 0) messages.push(truncate(value));
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (visited.has(value)) continue;
    visited.add(value);
    visitedNodes += 1;

    const record = value as Record<string, unknown>;
    inspectRecord(record, codes, messages);

    const enqueue = (child: unknown): void => {
      if (child === undefined || child === null) return;
      if (Array.isArray(child)) {
        for (const item of child.slice(0, MAX_ARRAY_ITEMS)) {
          queue.push({ value: item, depth: depth + 1 });
        }
      } else if (typeof child === "object" || typeof child === "string") {
        queue.push({ value: child, depth: depth + 1 });
      }
    };

    for (const key of Object.keys(record)) enqueue(record[key]);
    // `Error.cause` is non-enumerable and is not returned by Object.keys.
    for (const key of ["cause", "originalError", "innerError"]) enqueue(record[key]);
  }

  return Object.freeze({
    codes: Object.freeze([...codes]),
    messages: Object.freeze(messages),
  });
}

function inspectRecord(
  record: Record<string, unknown>,
  codes: Set<string>,
  messages: string[],
): void {
  for (const key of ["code", "sqlState", "sqlstate", "errno", "routine"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 32) {
      codes.add(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      codes.add(String(value));
    }
  }

  const message = record["message"];
  if (typeof message === "string" && message.length > 0) {
    messages.push(truncate(message));
  }
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? value.slice(0, MAX_MESSAGE_LENGTH) : value;
}
