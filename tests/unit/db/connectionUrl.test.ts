import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseConnectionUrlError,
  resolveDatabaseConnectionUrl,
} from "@/lib/db/connectionUrl";

const VALID = "postgresql://user:secret@db.internal:5432/app";

function errorReason(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.equal(error instanceof DatabaseConnectionUrlError, true);
    return (error as DatabaseConnectionUrlError).reason;
  }
  throw new Error("expected DatabaseConnectionUrlError");
}

test("each role prefers its own variable and falls back to the shared runtime URL", () => {
  const read = resolveDatabaseConnectionUrl("read", {
    DATABASE_URL: VALID,
    DATABASE_READ_URL: "postgresql://reader:secret@db.internal:5432/app",
    DATABASE_WRITE_URL: "postgresql://writer:secret@db.internal:5432/app",
  });
  assert.equal(read.variable, "DATABASE_READ_URL");
  assert.equal(read.url.startsWith("postgresql://reader:"), true);

  const writeFallback = resolveDatabaseConnectionUrl("write", { DATABASE_URL: VALID });
  assert.equal(writeFallback.variable, "DATABASE_URL");
  assert.equal(writeFallback.url, VALID);

  const readFallback = resolveDatabaseConnectionUrl("read", { DATABASE_URL: VALID });
  assert.equal(readFallback.variable, "DATABASE_URL");
});

test("missing and malformed URLs are rejected per role", () => {
  assert.equal(errorReason(() => resolveDatabaseConnectionUrl("read", {})), "MISSING_CONNECTION_URL");
  assert.equal(
    errorReason(() => resolveDatabaseConnectionUrl("write", { DATABASE_URL: "   " })),
    "MISSING_CONNECTION_URL",
  );
  assert.equal(
    errorReason(() => resolveDatabaseConnectionUrl("read", { DATABASE_URL: "not a url" })),
    "INVALID_CONNECTION_URL",
  );
  assert.equal(
    errorReason(() => resolveDatabaseConnectionUrl("read", { DATABASE_URL: "mysql://db/app" })),
    "INVALID_CONNECTION_URL_PROTOCOL",
  );
  assert.equal(
    errorReason(() => resolveDatabaseConnectionUrl("read", { DATABASE_URL: "prisma://db/app" })),
    "INVALID_CONNECTION_URL_PROTOCOL",
  );
});

test("URL parameters that would override the budget are rejected", () => {
  const conflicting = [
    "connection_limit=5",
    "pool_timeout=10",
    "statement_timeout=1",
    "lock_timeout=1",
    "idle_in_transaction_session_timeout=1",
    "query_timeout=1",
    "application_name=evil",
  ];

  for (const parameter of conflicting) {
    assert.equal(
      errorReason(() => resolveDatabaseConnectionUrl("read", {
        DATABASE_URL: `${VALID}?${parameter}`,
      })),
      "CONFLICTING_CONNECTION_URL_PARAMETER",
      parameter,
    );
  }
});

test("server options may set unrelated settings but not budget GUCs", () => {
  assert.doesNotThrow(() => resolveDatabaseConnectionUrl("read", {
    DATABASE_URL: `${VALID}?options=${encodeURIComponent("-c search_path=public")}`,
  }));

  assert.equal(
    errorReason(() => resolveDatabaseConnectionUrl("read", {
      DATABASE_URL: `${VALID}?options=${encodeURIComponent("-c statement_timeout=0")}`,
    })),
    "CONFLICTING_CONNECTION_URL_OPTION",
  );
});

test("connection URL errors never echo the connection string", () => {
  const secret = `${VALID}?connection_limit=5`;
  try {
    resolveDatabaseConnectionUrl("read", { DATABASE_URL: secret });
    assert.fail("expected an error");
  } catch (error) {
    const serialized = JSON.stringify({
      message: (error as Error).message,
      name: (error as Error).name,
      reason: (error as DatabaseConnectionUrlError).reason,
      code: (error as DatabaseConnectionUrlError).code,
    });
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("db.internal"), false);
    assert.equal(serialized.includes(secret), false);
  }
});
