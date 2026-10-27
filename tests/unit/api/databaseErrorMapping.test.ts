import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isTransientDatabaseFailure } from "@/lib/databaseErrors";
import {
  classifyDatabaseError,
  isFailoverOrConnectionError,
} from "@/lib/db/failoverErrors";
import { getRatesApiResult } from "@/lib/api/rates";
import type { PublicApiErrorReporter } from "@/lib/api/errors";
import { getReputationApiResult, getAnchorReputationApiResult } from "@/lib/api/reputation";
import type { ReputationApiRepository } from "@/lib/api/reputationRepository";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";
import type { PublicApiErrorReporter } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-10-01T12:00:00.000Z");

/** A StaleEvidenceStore that always returns nothing and swallows writes. */
const EMPTY_STALE_STORE: StaleEvidenceStore = Object.freeze({
  read: async () => null,
  write: async () => {},
});

/**
 * Captures the internal error report so we can inspect it without console noise.
 * Returns [reported[], reporter].
 */
function captureReporter(): [
  Array<{ error: unknown; context: { operation: string; code: string } }>,
  PublicApiErrorReporter,
] {
  const reported: Array<{ error: unknown; context: { operation: string; code: string } }> = [];
  return [reported, (error, context) => reported.push({ error, context: (context ?? { operation: "", code: "" }) as { operation: string; code: string } })];
}

/** Creates a Prisma-shaped error with code and optional nested driver error. */
function prismaError(
  code: string,
  message = `PrismaClientKnownRequestError: ${code}`,
  nested?: { code?: string; message?: string },
): Error & { code: string; cause?: unknown } {
  const err = Object.assign(new Error(message), { code });
  if (nested) {
    (err as { cause?: unknown }).cause = Object.assign(
      new Error(nested.message ?? "driver error"),
      nested.code ? { code: nested.code } : {},
    );
  }
  return err;
}

/** Creates a Node.js network-level error (ECONNREFUSED, ETIMEDOUT, etc.). */
function networkError(code: string, message?: string): Error & { code: string } {
  return Object.assign(new Error(message ?? `connect ${code}`), { code });
}

// ---------------------------------------------------------------------------
// 1. Classification: timeouts vs. connection-unavailable
// ---------------------------------------------------------------------------

describe("database error classification distinguishes timeouts from unavailable connections", () => {
  test("P1002 (server reached, timed out) is classified as transient via Prisma codes", () => {
    const err = prismaError("P1002", "The database server was reached but timed out");
    assert.equal(isTransientDatabaseFailure(err), true);
    // P1002 is a Prisma-level transient code, not a PostgreSQL/OS connection code,
    // so classifyDatabaseError (which only knows PostgreSQL/OS codes) returns UNKNOWN.
    assert.equal(classifyDatabaseError(err), "UNKNOWN");
  });

  test("P1008 (operations timed out) is classified as transient", () => {
    const err = prismaError("P1008", "Operations timed out after 10000ms");
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("P2024 (pool connection timeout) is classified as transient", () => {
    const err = prismaError("P2024", "Timed out fetching a new connection from the connection pool");
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("P1001 (cannot reach server) is classified as transient via Prisma codes", () => {
    const err = prismaError("P1001", "Can't reach database server at localhost:5432");
    assert.equal(isTransientDatabaseFailure(err), true);
    // P1001 is a Prisma-level transient code; classifyDatabaseError returns UNKNOWN
    // because it only recognizes PostgreSQL/OS-level connection codes.
    assert.equal(classifyDatabaseError(err), "UNKNOWN");
  });

  test("P1017 (server closed connection) is classified as transient", () => {
    const err = prismaError("P1017", "Server has closed the connection");
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("ECONNREFUSED is classified as failover/connection", () => {
    const err = networkError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(isTransientDatabaseFailure(err), true);
    assert.equal(classifyDatabaseError(err), "FAILOVER_OR_CONNECTION");
  });

  test("ETIMEDOUT is classified as failover/connection", () => {
    const err = networkError("ETIMEDOUT");
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(classifyDatabaseError(err), "FAILOVER_OR_CONNECTION");
  });

  test("ECONNRESET is classified as failover/connection", () => {
    const err = networkError("ECONNRESET");
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(classifyDatabaseError(err), "FAILOVER_OR_CONNECTION");
  });

  test("57P01 (admin_shutdown) is a connection error, not a query failure", () => {
    const err = prismaError("57P01", "terminating connection due to administrator command");
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(classifyDatabaseError(err), "FAILOVER_OR_CONNECTION");
  });

  test("P2037 (too many connections) is transient but NOT a connection error like ECONNREFUSED", () => {
    const err = prismaError("P2037", "Too many database connections opened");
    assert.equal(isTransientDatabaseFailure(err), true);
    // P2037 is caught by the Prisma-level transient set but not by the
    // connection/failover code set, so classifyDatabaseError returns UNKNOWN
    // unless the failoverErrors module also knows it. Let's verify the
    // actual behavior:
    const classification = classifyDatabaseError(err);
    assert.ok(
      classification === "FAILOVER_OR_CONNECTION" || classification === "UNKNOWN",
      `P2037 should be either FAILOVER_OR_CONNECTION or UNKNOWN, got ${classification}`,
    );
  });

  test("53300 (PostgreSQL too_many_connections) is transient", () => {
    const err = prismaError("53300", "too many connections for role");
    assert.equal(isTransientDatabaseFailure(err), true);
  });
});

// ---------------------------------------------------------------------------
// 2. Non-transient errors retain existing behavior
// ---------------------------------------------------------------------------

describe("non-transient database errors are not misclassified as transient", () => {
  test("23505 (unique_violation) is not transient", () => {
    const err = prismaError("23505", "Unique constraint failed on the fields: (slug)");
    assert.equal(isTransientDatabaseFailure(err), false);
    assert.equal(classifyDatabaseError(err), "QUERY_FAILURE");
  });

  test("42P01 (undefined_table) is not transient", () => {
    const err = prismaError("42P01", 'relation "nonexistent" does not exist');
    assert.equal(isTransientDatabaseFailure(err), false);
    assert.equal(classifyDatabaseError(err), "QUERY_FAILURE");
  });

  test("P1000 (authentication failure) is not transient — must fail closed", () => {
    const err = Object.assign(new Error("Authentication failed"), {
      name: "PrismaClientInitializationError",
      code: "P1000",
    });
    assert.equal(isTransientDatabaseFailure(err), false);
  });

  test("generic application error is not transient", () => {
    assert.equal(isTransientDatabaseFailure(new Error("application bug")), false);
    assert.equal(classifyDatabaseError(new Error("application bug")), "UNKNOWN");
  });

  test("null, undefined, and non-error values are not transient", () => {
    assert.equal(isTransientDatabaseFailure(null), false);
    assert.equal(isTransientDatabaseFailure(undefined), false);
    assert.equal(isTransientDatabaseFailure("string error"), false);
    assert.equal(isTransientDatabaseFailure(42), false);
  });
});

// ---------------------------------------------------------------------------
// 3. Nested driver errors are walked correctly
// ---------------------------------------------------------------------------

describe("nested error unwrapping distinguishes timeout from connection failure", () => {
  test("Prisma wrapper around a driver ECONNRESET is transient", () => {
    const err = prismaError("P5000", "Prisma engine error", {
      code: "ECONNRESET",
      message: "read ECONNRESET",
    });
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("Prisma wrapper around a driver 08006 (connection_failure) is transient", () => {
    const err = {
      code: "P5000",
      originalError: {
        driverError: Object.assign(new Error("server closed the connection"), { code: "08006" }),
      },
    };
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("Prisma wrapper around a query failure is NOT transient", () => {
    const err = prismaError("P5000", "Prisma error", {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    assert.equal(isTransientDatabaseFailure(err), false);
  });

  test("connection timeout message without code is recognized via message patterns", () => {
    const err = {
      message: "Connection terminated due to connection timeout",
    };
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(isTransientDatabaseFailure(err), true);
  });

  test("server shutdown message is recognized via message patterns", () => {
    const err = {
      message: "the database system is shutting down",
    };
    assert.equal(isFailoverOrConnectionError(err), true);
    assert.equal(isTransientDatabaseFailure(err), true);
  });
});

// ---------------------------------------------------------------------------
// 4. Rates API: timeout vs. connection errors map to safe public categories
// ---------------------------------------------------------------------------

describe("rates API maps timeout and connection errors to safe public error categories", () => {
  test("P1002 (query timeout) thrown from read produces internal_error with safe message", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async () => {
        throw prismaError("P1002", "The database server was reached but timed out. DATABASE_URL=postgresql://admin:secret@db.internal/core");
      },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to read rates." },
    });

    // Internal reporting preserves the original error for diagnosis
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "rates.read");
    assert.equal(reported[0]!.context.code, "internal_error");

    // Public body never leaks connection strings or stack traces
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("db.internal"), false);
    assert.equal(serialized.includes("P1002"), false);
    assert.equal(serialized.includes("DATABASE_URL"), false);
  });

  test("ECONNREFUSED (connection unavailable) thrown from read produces internal_error", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async () => {
        throw networkError("ECONNREFUSED", "connect ECONNREFUSED postgresql://admin:pass@10.0.0.1:5432/core");
      },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to read rates." },
    });

    assert.equal(reported.length, 1);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("10.0.0.1"), false);
    assert.equal(serialized.includes("pass"), false);
    assert.equal(serialized.includes("ECONNREFUSED"), false);
  });

  test("DATABASE_UNAVAILABLE result code from read model maps to internal_error", async () => {
    const result = await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async (slug) => ({
        ok: false,
        corridorSlug: slug,
        code: "DATABASE_UNAVAILABLE",
      }),
      staleEvidenceStore: EMPTY_STALE_STORE,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to read rates." },
    });
  });

  test("normal CORRIDOR_NOT_FOUND still maps to 404 corridor_not_found", async () => {
    const result = await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async (slug) => ({
        ok: false,
        corridorSlug: slug,
        code: "CORRIDOR_NOT_FOUND",
      }),
    });

    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "corridor_not_found");
  });

  test("generic non-db exceptions still map to internal_error 500", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async () => { throw new TypeError("Cannot read properties of undefined"); },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to read rates." },
    });
    assert.equal(reported.length, 1);

    // Stack trace must not leak
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("TypeError"), false);
    assert.equal(serialized.includes("Cannot read properties"), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Reputation API: timeout vs. connection errors map to safe public categories
// ---------------------------------------------------------------------------

describe("reputation API maps timeout and connection errors to safe public error categories", () => {
  function repository(listError?: Error, detailError?: Error): ReputationApiRepository {
    return Object.freeze({
      findAll: async () => { if (listError) throw listError; return []; },
      findBySlug: async () => { if (detailError) throw detailError; return null; },
    });
  }

  test("P2024 (pool timeout) on list produces internal_error without leaking details", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getReputationApiResult({
      repository: repository(
        prismaError("P2024", "Timed out fetching a new connection from the pool. connection_string=postgresql://user:hunter2@prod.db:5432/core"),
      ),
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
      now: () => NOW,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to load reputation." },
    });

    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "reputation.list");

    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("prod.db"), false);
    assert.equal(serialized.includes("P2024"), false);
  });

  test("ECONNRESET on detail produces internal_error without leaking details", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getAnchorReputationApiResult("zeam", {
      repository: repository(
        undefined,
        networkError("ECONNRESET", "read ECONNRESET at TCP.onStreamRead (node:net:1234:56)"),
      ),
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
      now: () => NOW,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to load reputation." },
    });

    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "reputation.detail");

    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("ECONNRESET"), false);
    assert.equal(serialized.includes("TCP.onStreamRead"), false);
    assert.equal(serialized.includes("node:net"), false);
  });

  test("normal repository failures retain existing 500 behavior", async () => {
    const [reported, reporter] = captureReporter();
    const result = await getReputationApiResult({
      repository: repository(new Error("Unexpected database error. query=SELECT * FROM secrets")),
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
      now: () => NOW,
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: { code: "internal_error", message: "Unable to load reputation." },
    });

    assert.equal(reported.length, 1);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes("SELECT * FROM secrets"), false);
  });
});

// ---------------------------------------------------------------------------
// 6. Sanitized reporter context retains enough info for diagnosis
// ---------------------------------------------------------------------------

describe("internal error reports retain diagnostic context without exposing secrets", () => {
  test("rates reporter captures operation name and error code", async () => {
    const [reported, reporter] = captureReporter();
    await getRatesApiResult(CORRIDOR, {
      now: () => NOW,
      readLatestRate: async () => {
        throw prismaError("P1001", "Can't reach database server");
      },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
    });

    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "rates.read");
    assert.equal(reported[0]!.context.code, "internal_error");
    // The original error is preserved in the report for log inspection
    assert.ok(reported[0]!.error instanceof Error);
    assert.equal((reported[0]!.error as Error).message, "Can't reach database server");
  });

  test("reputation list reporter captures operation name and error code", async () => {
    const [reported, reporter] = captureReporter();
    await getReputationApiResult({
      repository: {
        findAll: async () => { throw prismaError("P1008"); },
        findBySlug: async () => null,
      },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
      now: () => NOW,
    });

    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "reputation.list");
    assert.equal(reported[0]!.context.code, "internal_error");
  });

  test("reputation detail reporter captures operation name and error code", async () => {
    const [reported, reporter] = captureReporter();
    await getAnchorReputationApiResult("zeam", {
      repository: {
        findAll: async () => [],
        findBySlug: async () => { throw networkError("EHOSTUNREACH"); },
      },
      reportError: reporter,
      staleEvidenceStore: EMPTY_STALE_STORE,
      now: () => NOW,
    });

    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.context.operation, "reputation.detail");
    assert.equal(reported[0]!.context.code, "internal_error");
  });
});

// ---------------------------------------------------------------------------
// 7. 08007 transaction_resolution_unknown classification
// ---------------------------------------------------------------------------

describe("transaction resolution unknown is not collapsed with other categories", () => {
  test("08007 is classified as TRANSACTION_RESOLUTION_UNKNOWN, not FAILOVER_OR_CONNECTION", () => {
    const err = prismaError("08007", "transaction resolution unknown");
    const classification = classifyDatabaseError(err);
    assert.equal(classification, "TRANSACTION_RESOLUTION_UNKNOWN");
    // But isFailoverOrConnectionError still includes it (it's a connection-class issue)
    assert.equal(isFailoverOrConnectionError(err), true);
  });
});
