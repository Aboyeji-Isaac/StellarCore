import assert from "node:assert/strict";
import test from "node:test";

import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type { MigrationRecord } from "@/scripts/migration-rehearsal/lib/types.ts";

const { assertIsolatedRehearsal, REPO_ROOT, splitSqlStatements } = CORE_UTILS;

const SAFE_ENV = Object.freeze({
  STELLARCORE_ENVIRONMENT: "test",
  STELLARCORE_MIGRATION_REHEARSAL: "allow-destructive",
});

test("rehearsal guard rejects missing destructive confirmation", () => {
  assert.throws(
    () =>
      assertIsolatedRehearsal(
        "postgresql://user:pass@localhost:5432/stellarcore_rehearsal",
        { STELLARCORE_ENVIRONMENT: "test" },
      ),
    /SAFETY VIOLATION/,
  );
});

test("rehearsal guard rejects production, preview, and development identities", () => {
  for (const identity of ["production", "preview", "development"]) {
    assert.throws(
      () =>
        assertIsolatedRehearsal(
          "postgresql://user:pass@localhost:5432/stellarcore_rehearsal",
          {
            STELLARCORE_ENVIRONMENT: identity,
            STELLARCORE_MIGRATION_REHEARSAL: "allow-destructive",
          },
        ),
      /SAFETY VIOLATION/,
    );
  }
});

test("rehearsal guard rejects non-loopback databases even with test identity", () => {
  for (const host of ["staging.example.com", "db.internal", "supabase.co"]) {
    assert.throws(
      () =>
        assertIsolatedRehearsal(
          `postgresql://user:pass@${host}:5432/stellarcore_rehearsal`,
          SAFE_ENV,
        ),
      /SAFETY VIOLATION/,
    );
  }
});

test("rehearsal guard requires an explicitly named rehearsal database", () => {
  assert.throws(
    () =>
      assertIsolatedRehearsal(
        "postgresql://user:pass@localhost:5432/stellarcore",
        SAFE_ENV,
      ),
    /SAFETY VIOLATION/,
  );
});

test("rehearsal guard accepts only explicit local rehearsal targets", () => {
  for (const url of [
    "postgresql://user:pass@localhost:5432/stellarcore_rehearsal",
    "postgresql://user:pass@127.0.0.1:5432/rehearsal_test",
  ]) {
    assert.doesNotThrow(() => assertIsolatedRehearsal(url, SAFE_ENV));
  }
});

test("REPO_ROOT points to repository root", () => {
  assert.ok(REPO_ROOT.endsWith("StellarCore"));
  assert.ok(REPO_ROOT.includes("StellarCore"));
});

test("splitSqlStatements correctly parses migration SQL", () => {
  const sql = `
    CREATE TABLE "test" ("id" UUID);
    -- This is a comment;
    CREATE INDEX "idx_test" ON "test" ("id");
    CREATE TYPE "test_status" AS ENUM ('a', 'b');
  `;

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 3);
  assert.ok(statements[0].includes("CREATE TABLE"));
  assert.ok(statements[1].includes("CREATE INDEX"));
  assert.ok(statements[2].includes("CREATE TYPE"));
});

test("splitSqlStatements handles empty lines and comments", () => {
  const sql = `
    -- Comment only;
    CREATE TABLE "a" ("id" INT);

    CREATE INDEX "idx" ON "a" ("id");
  `;

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 2);
});

test("MigrationRecord type structure", () => {
  const record: MigrationRecord = {
    id: "test-id",
    checksum: "abc123",
    finishedAt: new Date("2026-01-01T00:00:00.000Z"),
    migrationName: "20260818140749_init",
    logs: "test logs",
    rolledBackAt: null,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    appliedStepsCount: 5,
  };

  assert.equal(record.id, "test-id");
  assert.equal(record.checksum, "abc123");
  assert.ok(record.finishedAt instanceof Date);
  assert.equal(record.migrationName, "20260818140749_init");
  assert.equal(record.appliedStepsCount, 5);
});

test("Scenario modules exist and export expected functions", async () => {
  const { runScenario1 } = await import("@/scripts/migration-rehearsal/scenarios/scenario1.ts");
  const { runScenario2 } = await import("@/scripts/migration-rehearsal/scenarios/scenario2.ts");
  const { runScenario3 } = await import("@/scripts/migration-rehearsal/scenarios/scenario3.ts");

  assert.ok(typeof runScenario1 === "function");
  assert.ok(typeof runScenario2 === "function");
  assert.ok(typeof runScenario3 === "function");
});

test("Scenario constants are exported", async () => {
  const { SCENARIO_1_ID, SCENARIO_1_NAME } = await import("@/scripts/migration-rehearsal/scenarios/scenario1.ts");
  const { SCENARIO_2_ID, SCENARIO_2_NAME } = await import("@/scripts/migration-rehearsal/scenarios/scenario2.ts");
  const { SCENARIO_3_ID, SCENARIO_3_NAME } = await import("@/scripts/migration-rehearsal/scenarios/scenario3.ts");

  assert.equal(SCENARIO_1_ID, "pre-schema-failure");
  assert.ok(SCENARIO_1_NAME.includes("idempotent"));
  assert.equal(SCENARIO_2_ID, "partial-apply-failure");
  assert.ok(SCENARIO_2_NAME.includes("partial"));
  assert.equal(SCENARIO_3_ID, "post-schema-checksum-mismatch");
  assert.ok(SCENARIO_3_NAME.includes("checksum"));
});