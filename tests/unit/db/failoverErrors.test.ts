import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDatabaseError,
  isFailoverOrConnectionError,
  isTransactionResolutionUnknown,
} from "@/lib/db/failoverErrors";

test("identifies Node.js network error codes as failover/connection errors", () => {
  const codes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
  ];

  for (const code of codes) {
    const error = Object.assign(new Error(`Network error ${code}`), { code });
    assert.equal(isFailoverOrConnectionError(error), true, `Failed for code ${code}`);
    assert.equal(classifyDatabaseError(error), "FAILOVER_OR_CONNECTION", `Failed classification for ${code}`);
  }
});

test("identifies PostgreSQL Class 08 and 57P codes and demotion code as failover/connection errors", () => {
  const codes = [
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "57P01",
    "57P02",
    "57P03",
    "25006",
  ];

  for (const code of codes) {
    const error = Object.assign(new Error(`Postgres error ${code}`), { code });
    assert.equal(isFailoverOrConnectionError(error), true, `Failed for code ${code}`);
    assert.equal(classifyDatabaseError(error), "FAILOVER_OR_CONNECTION", `Failed classification for ${code}`);
  }
});

test("identifies SQLState 08007 as ambiguous transaction resolution and failover error", () => {
  const error = Object.assign(new Error("Transaction resolution unknown"), { code: "08007" });
  assert.equal(isTransactionResolutionUnknown(error), true);
  assert.equal(isFailoverOrConnectionError(error), true);
  assert.equal(classifyDatabaseError(error), "TRANSACTION_RESOLUTION_UNKNOWN");
});

test("identifies failover error message patterns even without error codes", () => {
  const messages = [
    "Connection terminated unexpectedly",
    "Connection terminated",
    "Connection closed",
    "Client has encountered a connection error and is not queryable",
    "FATAL: terminating connection due to administrator command",
    "FATAL: the database system is in recovery mode",
    "FATAL: the database system is shutting down",
    "server closed the connection unexpectedly",
    "could not connect to server: Connection refused",
    "timeout exceeded when trying to connect",
  ];

  for (const msg of messages) {
    const error = new Error(msg);
    assert.equal(isFailoverOrConnectionError(error), true, `Failed for message: ${msg}`);
  }
});

test("unpacks nested causes and driverError objects", () => {
  const rootCause = Object.assign(new Error("ECONNRESET occurred"), { code: "ECONNRESET" });
  const wrapperError = new Error("Prisma query failed", { cause: rootCause });

  assert.equal(isFailoverOrConnectionError(wrapperError), true);
  assert.equal(classifyDatabaseError(wrapperError), "FAILOVER_OR_CONNECTION");

  const driverErrorWrapper = {
    message: "Driver failure",
    driverError: { code: "57P01", message: "admin_shutdown" },
  };
  assert.equal(isFailoverOrConnectionError(driverErrorWrapper), true);
  assert.equal(classifyDatabaseError(driverErrorWrapper), "FAILOVER_OR_CONNECTION");
});

test("normal query errors and constraints are NOT classified as failover errors", () => {
  const queryErrors = [
    { code: "23505", message: "duplicate key value violates unique constraint" },
    { code: "23503", message: "violates foreign key constraint" },
    { code: "23502", message: "null value in column violates not-null constraint" },
    { code: "42P01", message: 'relation "unknown_table" does not exist' },
    { code: "42703", message: 'column "unknown_col" does not exist' },
    { code: "42601", message: "syntax error at or near SELECT" },
    { code: "22P02", message: "invalid input syntax for type uuid" },
    { code: "40001", message: "could not serialize access due to read/write dependencies" },
    { code: "40P01", message: "deadlock detected" },
  ];

  for (const qErr of queryErrors) {
    const error = Object.assign(new Error(qErr.message), { code: qErr.code });
    assert.equal(isFailoverOrConnectionError(error), false, `Should not be connection error: ${qErr.code}`);
    assert.equal(isTransactionResolutionUnknown(error), false);
    assert.equal(classifyDatabaseError(error), "QUERY_FAILURE", `Should classify as QUERY_FAILURE: ${qErr.code}`);
  }
});

test("handles null, undefined, and non-error inputs gracefully", () => {
  assert.equal(isFailoverOrConnectionError(null), false);
  assert.equal(isFailoverOrConnectionError(undefined), false);
  assert.equal(isFailoverOrConnectionError("just a string"), false);
  assert.equal(isFailoverOrConnectionError({}), false);

  assert.equal(classifyDatabaseError(null), "UNKNOWN");
  assert.equal(classifyDatabaseError(undefined), "UNKNOWN");
  assert.equal(classifyDatabaseError({ message: "something weird" }), "UNKNOWN");
});
