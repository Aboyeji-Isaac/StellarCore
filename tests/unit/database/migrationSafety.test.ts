import assert from "node:assert/strict";
import test from "node:test";

import {
  checkMigrationTargetSafety,
  KNOWN_STELLARCORE_TABLES,
  type MigrationIntrospectionClient,
} from "@/lib/database/migrationSafety";

test("clean target database is detected and allowed for migration", async () => {
  const emptyClient: MigrationIntrospectionClient = {
    async listTables() {
      return [];
    },
  };

  const resultEmpty = await checkMigrationTargetSafety(emptyClient);
  assert.equal(resultEmpty.safe, true);
  if (resultEmpty.safe) {
    assert.equal(resultEmpty.state, "CLEAN");
    assert.deepEqual(resultEmpty.tables, []);
  }

  const initialPrismaOnly: MigrationIntrospectionClient = {
    async listTables() {
      return ["_prisma_migrations"];
    },
  };

  const resultPrisma = await checkMigrationTargetSafety(initialPrismaOnly);
  assert.equal(resultPrisma.safe, true);
  if (resultPrisma.safe) {
    assert.equal(resultPrisma.state, "CLEAN");
    assert.deepEqual(resultPrisma.tables, ["_prisma_migrations"]);
  }
});

test("target database with unexpected existing tables is blocked with safe diagnostic", async () => {
  const dirtyClient: MigrationIntrospectionClient = {
    async listTables() {
      return ["anchors", "legacy_customers", "billing_records", "rate_snapshots"];
    },
  };

  const result = await checkMigrationTargetSafety(dirtyClient);
  assert.equal(result.safe, false);
  if (!result.safe) {
    assert.equal(result.incompatibilityClass, "UNEXPECTED_TABLES");
    assert.deepEqual(result.unexpectedTables, ["billing_records", "legacy_customers"]);
    assert.match(result.message, /unexpected existing table/);
    assert.doesNotMatch(result.message, /password|secret|database_url/i);
  }
});

test("target database with incompatible schema columns is detected and blocked", async () => {
  const incompatibleClient: MigrationIntrospectionClient = {
    async listTables() {
      return ["anchors", "corridors", "rate_snapshots"];
    },
    async listColumns(table: string) {
      if (table === "rate_snapshots") {
        return [
          { name: "id", type: "uuid" },
          // Missing 'rate', 'source_amount', 'captured_at'
        ];
      }
      return [
        { name: "id", type: "uuid" },
        { name: "slug", type: "text" },
      ];
    },
  };

  const result = await checkMigrationTargetSafety(incompatibleClient, {
    requiredColumns: {
      rate_snapshots: ["id", "rate", "captured_at"],
      anchors: ["id", "slug"],
    },
  });

  assert.equal(result.safe, false);
  if (!result.safe) {
    assert.equal(result.incompatibilityClass, "SCHEMA_INCOMPATIBILITY");
    assert.deepEqual(result.incompatibleColumns, [
      "rate_snapshots.captured_at",
      "rate_snapshots.rate",
    ]);
  }
});

test("existing compatible StellarCore database is allowed for additive migration", async () => {
  const compatibleClient: MigrationIntrospectionClient = {
    async listTables() {
      return [...KNOWN_STELLARCORE_TABLES];
    },
  };

  const result = await checkMigrationTargetSafety(compatibleClient);
  assert.equal(result.safe, true);
  if (result.safe) {
    assert.equal(result.state, "COMPATIBLE");
    assert.equal(result.tables.length, KNOWN_STELLARCORE_TABLES.length);
  }
});

test("preflight execution is strictly read-only and does not overwrite or mutate existing data", async () => {
  let writeAttempted = false;

  const readOnlyClient: MigrationIntrospectionClient & { executeDdl?: () => void } = {
    async listTables() {
      return ["anchors", "corridors", "unrecognized_table"];
    },
    executeDdl() {
      writeAttempted = true;
    },
  };

  const result = await checkMigrationTargetSafety(readOnlyClient);
  assert.equal(writeAttempted, false, "Preflight must never invoke DDL or DML mutations");
  assert.equal(result.safe, false);
});
