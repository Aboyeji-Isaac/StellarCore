import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATION_SQL = readFileSync(fileURLToPath(new URL(
  "../../../prisma/migrations/20260928120000_add_rate_snapshot_source_authority/migration.sql",
  import.meta.url,
)), "utf8");

const SCHEMA = readFileSync(
  fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

test("migration adds nullable authority provenance to rate snapshots", () => {
  assert.match(MIGRATION_SQL, /ADD COLUMN "authority_id" TEXT;/);
  assert.match(MIGRATION_SQL, /ADD COLUMN "authority_configuration_version" INTEGER;/);
  assert.equal(/ADD COLUMN[^;]*NOT NULL/i.test(MIGRATION_SQL), false);
});

test("migration never fabricates a historical authority mapping", () => {
  assert.equal(/\bUPDATE\b/i.test(MIGRATION_SQL), false);
  assert.equal(/\bSET\b/i.test(MIGRATION_SQL), false);
  assert.equal(/DEFAULT\s+'auth-/i.test(MIGRATION_SQL), false);
});

test("migration keeps authority provenance all-or-nothing", () => {
  assert.match(MIGRATION_SQL, /CONSTRAINT "rate_snapshots_authority_provenance_check"/);
  assert.match(MIGRATION_SQL, /"authority_id" IS NULL AND "authority_configuration_version" IS NULL/);
  assert.match(MIGRATION_SQL, /"authority_id" ~ '\^auth-\[0-9\]\{4\}\$'/);
  assert.match(MIGRATION_SQL, /"authority_configuration_version" > 0/);
});

test("migration recreates the covering index with the authority columns", () => {
  assert.match(MIGRATION_SQL, /DROP INDEX "rate_snapshots_latest_observation_idx";/);
  assert.match(
    MIGRATION_SQL,
    /CREATE INDEX "rate_snapshots_latest_observation_idx" ON "rate_snapshots"\([^;]*"authority_id", "authority_configuration_version"\);/,
  );
});

test("schema declares the authority provenance and covering index", () => {
  assert.match(SCHEMA, /authorityId\s+String\?\s+@map\("authority_id"\)/);
  assert.match(SCHEMA, /authorityConfigurationVersion Int\?\s+@map\("authority_configuration_version"\)/);
  assert.match(SCHEMA, /fee, authorityId, authorityConfigurationVersion\]/);
});
