import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDatabaseFailure,
  DatabaseResourceError,
  toDatabaseResourceError,
} from "@/lib/db/errors";

function withCode(code: string, message = "driver detail"): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

test("PostgreSQL SQLSTATE signals map to bounded failure codes", () => {
  assert.equal(classifyDatabaseFailure(withCode("57014")).code, "database_statement_timeout");
  assert.equal(classifyDatabaseFailure(withCode("55P03")).code, "database_lock_timeout");
  assert.equal(classifyDatabaseFailure(withCode("25P03")).code, "database_idle_transaction_timeout");
  assert.equal(classifyDatabaseFailure(withCode("53300")).code, "database_too_many_connections");
  assert.equal(classifyDatabaseFailure(withCode("08006")).code, "database_connection_failure");
});

test("Node errno, Prisma codes, and pool timeout phrases are recognized", () => {
  assert.equal(classifyDatabaseFailure(withCode("ECONNREFUSED")).code, "database_connection_failure");
  assert.equal(classifyDatabaseFailure(withCode("ETIMEDOUT")).code, "database_connection_timeout");
  assert.equal(classifyDatabaseFailure(withCode("P2024")).code, "database_pool_timeout");
  assert.equal(
    classifyDatabaseFailure(new Error("timeout exceeded when trying to connect")).code,
    "database_pool_timeout",
  );
  assert.equal(
    classifyDatabaseFailure(new Error("Connection terminated due to connection timeout")).code,
    "database_connection_timeout",
  );
});

test("wrapped causes and Prisma meta are traversed", () => {
  const inner = withCode("55P03", "canceling statement due to lock timeout");
  const outer = new Error("Prisma raw query failed", { cause: inner });
  const result = classifyDatabaseFailure(outer);
  assert.equal(result.code, "database_lock_timeout");
  assert.equal(result.recognized, true);

  const prisma = new Error("known request error") as Error & { code: string; meta: unknown };
  prisma.code = "P2010";
  prisma.meta = { code: "57014", message: "canceling statement due to statement timeout" };
  assert.equal(classifyDatabaseFailure(prisma).code, "database_statement_timeout");
});

test("unclassified failures stay bounded and are marked unrecognized", () => {
  const result = classifyDatabaseFailure(new Error("something unexpected"));
  assert.equal(result.code, "database_unrecognized_failure");
  assert.equal(result.recognized, false);
  assert.equal(result.retryable, false);
});

test("translated errors never expose connection strings, hosts, users, or SQL", () => {
  const leaky = withCode(
    "ECONNREFUSED",
    "connect ECONNREFUSED postgresql://stellarcore:hunter2@db.internal:5432/app SELECT * FROM anchors",
  );
  const translated = toDatabaseResourceError(leaky);

  assert.equal(translated instanceof DatabaseResourceError, true);
  assert.equal(translated.code, "database_connection_failure");

  const serialized = JSON.stringify({
    name: translated.name,
    message: translated.message,
    code: translated.code,
    stack: translated.stack ?? "",
    serialized: translated,
  });
  for (const secret of ["hunter2", "db.internal", "postgresql://", "SELECT * FROM anchors", "stellarcore:"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
