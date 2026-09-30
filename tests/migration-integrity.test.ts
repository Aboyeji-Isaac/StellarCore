import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeMigrationDigest,
  generateMigrationManifest,
  normalizeSqlLineEndings,
  saveMigrationManifest,
  verifyMigrationIntegrity,
} from "../lib/migrations/integrity";

describe("Migration File Integrity Verification (Issue #236)", () => {
  it("normalizes CRLF and LF line endings deterministically", () => {
    const unixSql = "CREATE TABLE test (\n  id TEXT PRIMARY KEY\n);\n";
    const windowsSql = "CREATE TABLE test (\r\n  id TEXT PRIMARY KEY\r\n);\r\n";
    const oldMacSql = "CREATE TABLE test (\r  id TEXT PRIMARY KEY\r);\r";

    const digestUnix = computeMigrationDigest(unixSql);
    const digestWindows = computeMigrationDigest(windowsSql);
    const digestOldMac = computeMigrationDigest(oldMacSql);

    assert.strictEqual(digestUnix, digestWindows, "Unix and Windows SQL digests must match");
    assert.strictEqual(digestUnix, digestOldMac, "Unix and classic Mac SQL digests must match");
    assert.strictEqual(
      normalizeSqlLineEndings(windowsSql),
      unixSql,
      "CRLF must be normalized to LF",
    );
  });

  it("passes verification on unchanged reviewed migrations", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stellarcore-mig-test-"));
    try {
      const mig1Dir = join(tempDir, "20260101_init");
      const mig2Dir = join(tempDir, "20260201_indexes");
      mkdirSync(mig1Dir, { recursive: true });
      mkdirSync(mig2Dir, { recursive: true });

      writeFileSync(join(mig1Dir, "migration.sql"), "-- Initial migration\nCREATE TABLE a (id INT);");
      writeFileSync(join(mig2Dir, "migration.sql"), "-- Add index\nCREATE INDEX idx_a ON a(id);");

      const manifestPath = join(tempDir, "manifest.json");
      const manifest = generateMigrationManifest(tempDir);
      saveMigrationManifest(manifestPath, manifest);

      const result = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.totalHistorical, 2);
      assert.strictEqual(result.totalVerified, 2);
      assert.strictEqual(result.newMigrationsCount, 0);
      assert.strictEqual(result.errors.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detects and fails on modified historical migration file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stellarcore-mig-test-"));
    try {
      const migDir = join(tempDir, "20260101_init");
      mkdirSync(migDir, { recursive: true });
      const sqlFile = join(migDir, "migration.sql");

      writeFileSync(sqlFile, "-- Original SQL");
      const manifestPath = join(tempDir, "manifest.json");
      saveMigrationManifest(manifestPath, generateMigrationManifest(tempDir));

      // Tamper with the file
      writeFileSync(sqlFile, "-- Tampered SQL injection or unauthorized edit");

      const result = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
      });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.totalVerified, 0);
      const modDiag = result.diagnostics.find((d) => d.status === "MODIFIED");
      assert.ok(modDiag, "Diagnostic must report MODIFIED status");
      assert.ok(modDiag.actualDigest !== modDiag.expectedDigest);
      assert.ok(result.errors.some((e) => e.includes("historical migration modified")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detects and fails on missing historical migration file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stellarcore-mig-test-"));
    try {
      const migDir = join(tempDir, "20260101_init");
      mkdirSync(migDir, { recursive: true });
      const sqlFile = join(migDir, "migration.sql");

      writeFileSync(sqlFile, "-- Original SQL");
      const manifestPath = join(tempDir, "manifest.json");
      saveMigrationManifest(manifestPath, generateMigrationManifest(tempDir));

      // Delete migration file
      rmSync(sqlFile);

      const result = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
      });

      assert.strictEqual(result.ok, false);
      const missingDiag = result.diagnostics.find((d) => d.status === "MISSING");
      assert.ok(missingDiag, "Diagnostic must report MISSING status");
      assert.ok(result.errors.some((e) => e.includes("historical migration missing")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("supports adding new migrations without weakening historical checks", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stellarcore-mig-test-"));
    try {
      const mig1Dir = join(tempDir, "20260101_init");
      mkdirSync(mig1Dir, { recursive: true });
      writeFileSync(join(mig1Dir, "migration.sql"), "-- Original SQL");

      const manifestPath = join(tempDir, "manifest.json");
      saveMigrationManifest(manifestPath, generateMigrationManifest(tempDir));

      // Add a second, new migration
      const mig2Dir = join(tempDir, "20260301_new_feature");
      mkdirSync(mig2Dir, { recursive: true });
      writeFileSync(join(mig2Dir, "migration.sql"), "-- New Feature SQL");

      // Verify with allowNewMigrations: true (default)
      const result = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
        allowNewMigrations: true,
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.totalHistorical, 1);
      assert.strictEqual(result.totalVerified, 1);
      assert.strictEqual(result.newMigrationsCount, 1);
      assert.strictEqual(result.diagnostics.find((d) => d.status === "NEW")?.path, "20260301_new_feature/migration.sql");

      // Verify with strict mode (allowNewMigrations: false)
      const strictResult = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
        allowNewMigrations: false,
      });
      assert.strictEqual(strictResult.ok, false, "Strict mode must fail on unreviewed new migrations");
      assert.ok(strictResult.errors.some((e) => e.includes("Unreviewed new migration found")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not leak secrets or SQL query contents in diagnostics", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stellarcore-mig-test-"));
    try {
      const migDir = join(tempDir, "20260101_init");
      mkdirSync(migDir, { recursive: true });
      const secretSql = "INSERT INTO users (password) VALUES ('SUPER_SECRET_VALUE');";
      writeFileSync(join(migDir, "migration.sql"), secretSql);

      const manifestPath = join(tempDir, "manifest.json");
      saveMigrationManifest(manifestPath, generateMigrationManifest(tempDir));

      // Modify the file with another secret
      writeFileSync(join(migDir, "migration.sql"), "SECRET_CHANGE_12345");

      const result = verifyMigrationIntegrity({
        migrationsDir: tempDir,
        manifestPath,
      });

      const fullOutput = JSON.stringify(result);
      assert.strictEqual(fullOutput.includes("SUPER_SECRET_VALUE"), false);
      assert.strictEqual(fullOutput.includes("SECRET_CHANGE_12345"), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
