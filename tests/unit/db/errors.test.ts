import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  classifyDatabaseError,
  DatabaseBudgetError,
  toSafeDatabaseError,
} from "@/lib/db/errors";

// ---------------------------------------------------------------------------
// classifyDatabaseError
// ---------------------------------------------------------------------------

describe("classifyDatabaseError", () => {
  test("classifies non-Error values as DATABASE_ERROR", () => {
    assert.equal(classifyDatabaseError("string"), "DATABASE_ERROR");
    assert.equal(classifyDatabaseError(42), "DATABASE_ERROR");
    assert.equal(classifyDatabaseError(null), "DATABASE_ERROR");
    assert.equal(classifyDatabaseError(undefined), "DATABASE_ERROR");
  });

  test("classifies pool acquisition timeout", () => {
    const error = new Error("Timed out while waiting for available connection");
    assert.equal(classifyDatabaseError(error), "POOL_ACQUISITION_TIMEOUT");
  });

  test("classifies connection timeout variant", () => {
    const error = new Error("Connection timeout expired");
    assert.equal(classifyDatabaseError(error), "POOL_ACQUISITION_TIMEOUT");
  });

  test("classifies statement_timeout (SQLSTATE 57014)", () => {
    const error = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    assert.equal(classifyDatabaseError(error), "STATEMENT_TIMEOUT");
  });

  test("classifies lock_timeout (SQLSTATE 57014 with lock message)", () => {
    const error = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "57014",
    });
    assert.equal(classifyDatabaseError(error), "LOCK_TIMEOUT");
  });

  test("classifies lock_not_available (SQLSTATE 55P03)", () => {
    const error = Object.assign(new Error("could not obtain lock"), {
      code: "55P03",
    });
    assert.equal(classifyDatabaseError(error), "LOCK_TIMEOUT");
  });

  test("classifies connection exception (SQLSTATE 08xxx)", () => {
    const error = Object.assign(new Error("connection exception"), {
      code: "08006",
    });
    assert.equal(classifyDatabaseError(error), "CONNECTION_LOST");
  });

  test("classifies connection terminated", () => {
    const error = new Error("Connection terminated unexpectedly");
    assert.equal(classifyDatabaseError(error), "CONNECTION_LOST");
  });

  test("classifies ECONNRESET", () => {
    const error = new Error("read ECONNRESET");
    assert.equal(classifyDatabaseError(error), "CONNECTION_LOST");
  });

  test("classifies Prisma transaction timeout (P2028)", () => {
    const error = new Error("P2028: Transaction API error: Transaction already closed");
    assert.equal(classifyDatabaseError(error), "TRANSACTION_TIMEOUT");
  });

  test("classifies generic transaction timeout message", () => {
    const error = new Error("Interactive transaction timeout");
    assert.equal(classifyDatabaseError(error), "TRANSACTION_TIMEOUT");
  });

  test("classifies unknown errors as DATABASE_ERROR", () => {
    const error = new Error("Something completely unexpected");
    assert.equal(classifyDatabaseError(error), "DATABASE_ERROR");
  });

  test("ignores non-SQLSTATE code properties", () => {
    const error = Object.assign(new Error("some error"), { code: "ENOENT" });
    // ENOENT is not a 5-char alphanumeric SQLSTATE, so it won't match
    assert.equal(classifyDatabaseError(error), "DATABASE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// toSafeDatabaseError
// ---------------------------------------------------------------------------

describe("toSafeDatabaseError", () => {
  test("returns DatabaseBudgetError with safe message", () => {
    const raw = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const safe = toSafeDatabaseError(raw);
    assert.ok(safe instanceof DatabaseBudgetError);
    assert.equal(safe.code, "STATEMENT_TIMEOUT");
    assert.equal(safe.safeMessage, "A database query exceeded its time limit.");
  });

  test("safe message never contains connection details", () => {
    const raw = new Error(
      "connection to server at \"db.example.com\" (10.0.0.1), port 5432 failed: FATAL: password authentication failed for user \"admin\"",
    );
    const safe = toSafeDatabaseError(raw);
    assert.doesNotMatch(safe.safeMessage, /example\.com/);
    assert.doesNotMatch(safe.safeMessage, /admin/);
    assert.doesNotMatch(safe.safeMessage, /10\.0\.0\.1/);
    assert.doesNotMatch(safe.safeMessage, /5432/);
  });

  test("safe message never contains SQL", () => {
    const raw = Object.assign(
      new Error("ERROR: relation \"anchors\" does not exist\n  SELECT * FROM anchors"),
      { code: "42P01" },
    );
    const safe = toSafeDatabaseError(raw);
    assert.doesNotMatch(safe.safeMessage, /anchors/);
    assert.doesNotMatch(safe.safeMessage, /SELECT/);
  });

  test("pool exhaustion produces correct code and safe message", () => {
    const raw = new Error("Timed out while waiting for available connection");
    const safe = toSafeDatabaseError(raw);
    assert.equal(safe.code, "POOL_ACQUISITION_TIMEOUT");
    assert.doesNotMatch(safe.safeMessage, /connection/i);
    assert.ok(safe.safeMessage.length > 0);
  });
});

// ---------------------------------------------------------------------------
// DatabaseBudgetError
// ---------------------------------------------------------------------------

describe("DatabaseBudgetError", () => {
  test("has correct name", () => {
    const error = new DatabaseBudgetError("DATABASE_ERROR", "test");
    assert.equal(error.name, "DatabaseBudgetError");
  });

  test("is instanceof Error", () => {
    const error = new DatabaseBudgetError("DATABASE_ERROR", "test");
    assert.ok(error instanceof Error);
  });

  test("message matches safeMessage", () => {
    const error = new DatabaseBudgetError("STATEMENT_TIMEOUT", "safe msg");
    assert.equal(error.message, "safe msg");
    assert.equal(error.safeMessage, "safe msg");
  });
});
