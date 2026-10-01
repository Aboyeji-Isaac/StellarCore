import assert from "node:assert/strict";
import test from "node:test";

import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type { MigrationRecord } from "@/scripts/migration-rehearsal/lib/types.ts";

const { assertNotProduction, REPO_ROOT, splitSqlStatements } = CORE_UTILS;

test("assertNotProduction rejects production-like hostnames", () => {
  const prodUrls = [
    "postgresql://user:pass@prod.db.example.com:5432/db",
    "postgresql://user:pass@production-db.example.com:5432/db",
    "postgresql://user:pass@live.example.com:5432/db",
    "postgresql://user:pass@main.example.com:5432/db",
    "postgresql://user:pass@primary.example.com:5432/db",
    "postgresql://user:pass@aws.example.com:5432/db",
    "postgresql://user:pass@gcp.example.com:5432/db",
    "postgresql://user:pass@azure.example.com:5432/db",
    "postgresql://user:pass@vercel.example.com:5432/db",
    "postgresql://user:pass@supabase.example.com:5432/db",
    "postgresql://user:pass@neon.example.com:5432/db",
    "postgresql://user:pass@planetscale.example.com:5432/db",
  ];

  for (const url of prodUrls) {
    assert.throws(
      () => assertNotProduction(url),
      /SAFETY VIOLATION/,
      `Should reject: ${url}`,
    );
  }
});

test("assertNotProduction rejects Prisma production with sslmode=require", () => {
  const url = "postgresql://user:pass@abc123.prisma.io:5432/db?sslmode=require";
  assert.throws(
    () => assertNotProduction(url),
    /SAFETY VIOLATION/,
    `Should reject Prisma production: ${url}`,
  );
});

test("assertNotProduction allows local/staging databases", () => {
  const safeUrls = [
    "postgresql://user:pass@localhost:5432/db",
    "postgresql://user:pass@staging.db.example.com:5432/db",
    "postgresql://user:pass@test.example.com:5432/db",
    "postgresql://user:pass@127.0.0.1:5432/db",
    "postgresql://user:pass@db:5432/db",
    "postgresql://user:pass@rehearsal.example.com:5432/db",
  ];

  for (const url of safeUrls) {
    assert.doesNotThrow(
      () => assertNotProduction(url),
      `Should allow: ${url}`,
    );
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