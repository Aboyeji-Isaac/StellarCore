import assert from "node:assert/strict";
import test from "node:test";

import {
  auditDatabaseBudgetConfiguration,
  DatabaseBudgetConfigurationError,
  DATABASE_BUDGET_UNITS,
  databaseBudgetDefaults,
  databaseBudgetEnvironmentVariables,
  parseDatabaseBudgetConfiguration,
  requireDatabaseBudgetProfile,
} from "@/lib/db/budget";

function source(
  entries: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...entries };
}

test("defaults are finite, in range, and valid for both profiles", () => {
  const result = auditDatabaseBudgetConfiguration(source({}));

  assert.equal(result.ok, true);
  assert.notEqual(result.configuration, null);
  const configuration = result.configuration;
  if (!configuration) return;

  assert.equal(configuration.read.profile, "read");
  assert.equal(configuration.write.profile, "write");
  assert.equal(configuration.read.applicationName, "stellarcore:read");
  assert.equal(configuration.write.applicationName, "stellarcore:write");
  assert.equal(
    configuration.totalPoolMax,
    configuration.read.poolMax + configuration.write.poolMax,
  );

  for (const profile of [configuration.read, configuration.write]) {
    for (const [knob, bound] of Object.entries(DATABASE_BUDGET_UNITS)) {
      const value = profile[knob as keyof typeof DATABASE_BUDGET_UNITS];
      assert.equal(Number.isFinite(value), true, `${profile.profile}.${knob}`);
      assert.equal(Number.isInteger(value), true, `${profile.profile}.${knob}`);
      assert.equal(value >= bound.min && value <= bound.max, true, `${profile.profile}.${knob}`);
    }
  }
});

test("global values apply to both profiles and profile values win", () => {
  const configuration = parseDatabaseBudgetConfiguration(source({
    DB_POOL_MAX: "7",
    DB_READ_POOL_MAX: "2",
    DB_WRITE_STATEMENT_TIMEOUT_MS: "6000",
  }));

  assert.equal(configuration.read.poolMax, 2);
  assert.equal(configuration.write.poolMax, 7);
  assert.equal(configuration.write.statementTimeoutMs, 6000);
  assert.equal(configuration.read.statementTimeoutMs, databaseBudgetDefaults("read").statementTimeoutMs);
});

test("empty, non-integer, negative, non-finite, and unlimited overrides are rejected", () => {
  const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
    [{ DB_POOL_MAX: "" }, "EMPTY_VALUE"],
    [{ DB_POOL_MAX: "abc" }, "NOT_AN_INTEGER"],
    [{ DB_POOL_MAX: "-5" }, "NOT_AN_INTEGER"],
    [{ DB_POOL_MAX: "1.5" }, "NOT_AN_INTEGER"],
    [{ DB_POOL_MAX: "1e3" }, "NOT_AN_INTEGER"],
    [{ DB_POOL_MAX: "Infinity" }, "UNLIMITED_NOT_ALLOWED"],
    [{ DB_POOL_MAX: "NaN" }, "UNLIMITED_NOT_ALLOWED"],
    [{ DB_STATEMENT_TIMEOUT_MS: "0" }, "UNLIMITED_NOT_ALLOWED"],
    [{ DB_STATEMENT_TIMEOUT_MS: "off" }, "UNLIMITED_NOT_ALLOWED"],
    [{ DB_STATEMENT_TIMEOUT_MS: "false" }, "UNLIMITED_NOT_ALLOWED"],
    [{ DB_STATEMENT_TIMEOUT_MS: "unlimited" }, "UNLIMITED_NOT_ALLOWED"],
  ];

  for (const [entries, code] of cases) {
    const result = auditDatabaseBudgetConfiguration(source(entries));
    assert.equal(result.ok, false, JSON.stringify(entries));
    assert.equal(result.configuration, null);
    assert.equal(result.issues.some((issue) => issue.code === code), true, `${code} ${JSON.stringify(entries)}`);
  }
});

test("out-of-range values are rejected instead of silently clamped", () => {
  const tooHigh = auditDatabaseBudgetConfiguration(source({ DB_POOL_MAX: "101" }));
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.issues.some((issue) => issue.code === "OUT_OF_RANGE"), true);

  const tooLow = auditDatabaseBudgetConfiguration(source({ DB_STATEMENT_TIMEOUT_MS: "99" }));
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.issues.some((issue) => issue.code === "OUT_OF_RANGE"), true);
});

test("the environment variable names are stable for docs and deployment", () => {
  assert.deepEqual(databaseBudgetEnvironmentVariables("poolMax"), {
    global: "DB_POOL_MAX",
    read: "DB_READ_POOL_MAX",
    write: "DB_WRITE_POOL_MAX",
  });
  assert.deepEqual(databaseBudgetEnvironmentVariables("statementTimeoutMs"), {
    global: "DB_STATEMENT_TIMEOUT_MS",
    read: "DB_READ_STATEMENT_TIMEOUT_MS",
    write: "DB_WRITE_STATEMENT_TIMEOUT_MS",
  });
});

test("inconsistent profile bounds are rejected", () => {
  const lockAboveStatement = auditDatabaseBudgetConfiguration(source({
    DB_READ_LOCK_TIMEOUT_MS: "9000",
    DB_READ_STATEMENT_TIMEOUT_MS: "5000",
  }));
  assert.equal(lockAboveStatement.ok, false);
  assert.equal(
    lockAboveStatement.issues.some((issue) => issue.handle === "lockTimeoutMs<=statementTimeoutMs"),
    true,
  );

  const maxWaitAboveTransaction = auditDatabaseBudgetConfiguration(source({
    DB_WRITE_INTERACTIVE_TRANSACTION_MAX_WAIT_MS: "9000",
    DB_WRITE_INTERACTIVE_TRANSACTION_TIMEOUT_MS: "5000",
  }));
  assert.equal(maxWaitAboveTransaction.ok, false);
  assert.equal(
    maxWaitAboveTransaction.issues.some(
      (issue) => issue.handle === "interactiveTransactionMaxWaitMs<=interactiveTransactionTimeoutMs",
    ),
    true,
  );

  const statementAboveTransaction = auditDatabaseBudgetConfiguration(source({
    DB_READ_INTERACTIVE_TRANSACTION_TIMEOUT_MS: "1000",
    DB_READ_STATEMENT_TIMEOUT_MS: "5000",
  }));
  assert.equal(statementAboveTransaction.ok, false);
  assert.equal(
    statementAboveTransaction.issues.some(
      (issue) => issue.handle === "statementTimeoutMs<=interactiveTransactionTimeoutMs",
    ),
    true,
  );
});

test("application name must be a bounded PostgreSQL-safe identifier", () => {
  const invalid = auditDatabaseBudgetConfiguration(source({
    DB_APPLICATION_NAME: "bad name!",
  }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.some((issue) => issue.code === "INVALID_APPLICATION_NAME"), true);

  const empty = auditDatabaseBudgetConfiguration(source({ DB_APPLICATION_NAME: "" }));
  assert.equal(empty.ok, false);
  assert.equal(empty.issues.some((issue) => issue.code === "EMPTY_VALUE"), true);
});

test("parse throws a typed error and requireDatabaseBudgetProfile rejects unknown roles", () => {
  assert.throws(
    () => parseDatabaseBudgetConfiguration(source({ DB_POOL_MAX: "0" })),
    (error: unknown) => {
      assert.equal(error instanceof DatabaseBudgetConfigurationError, true);
      assert.equal(
        (error as DatabaseBudgetConfigurationError).code,
        "INVALID_DATABASE_BUDGET_CONFIGURATION",
      );
      return true;
    },
  );

  assert.throws(
    () => requireDatabaseBudgetProfile("owner"),
    (error: unknown) =>
      error instanceof DatabaseBudgetConfigurationError
      && error.issues.some((issue) => issue.code === "INVALID_PROFILE"),
  );
  assert.equal(requireDatabaseBudgetProfile("write"), "write");
});

test("issue messages never echo the offending value", () => {
  const secret = "postgresql://user:hunter2@db.internal:5432/app";
  const result = auditDatabaseBudgetConfiguration(source({ DB_POOL_MAX: secret }));
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result.issues);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("db.internal"), false);
  assert.equal(serialized.includes(secret), false);
});
