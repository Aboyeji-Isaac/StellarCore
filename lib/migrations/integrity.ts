import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface MigrationDigestEntry {
  path: string; // Relative path, e.g. "20260818140749_init/migration.sql"
  digest: string; // SHA-256 hex string
  byteLength: number;
}

export interface MigrationManifest {
  version: 1;
  algorithm: "sha256";
  generatedAt: string;
  migrations: Record<string, MigrationDigestEntry>;
}

export interface VerificationDiagnostic {
  path: string;
  status: "OK" | "MODIFIED" | "MISSING" | "NEW";
  expectedDigest?: string;
  actualDigest?: string;
  message: string;
}

export interface VerificationResult {
  ok: boolean;
  totalHistorical: number;
  totalVerified: number;
  newMigrationsCount: number;
  diagnostics: VerificationDiagnostic[];
  errors: string[];
}

/**
 * Normalizes text line endings to '\n' to guarantee deterministic hashing
 * across Windows (CRLF) and POSIX (LF) environments without altering semantic content.
 */
export function normalizeSqlLineEndings(content: string | Buffer): string {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Computes a deterministic SHA-256 digest of SQL migration content.
 */
export function computeMigrationDigest(content: string | Buffer): string {
  const normalized = normalizeSqlLineEndings(content);
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Discovers all migration.sql files in the migrations directory.
 */
export function discoverMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const migrationFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sqlFile = join(migrationsDir, entry.name, "migration.sql");
      if (existsSync(sqlFile)) {
        migrationFiles.push(sqlFile);
      }
    }
  }

  return migrationFiles.sort();
}

/**
 * Generates an in-memory or persisted MigrationManifest from the current migrations directory.
 */
export function generateMigrationManifest(migrationsDir: string): MigrationManifest {
  const files = discoverMigrationFiles(migrationsDir);
  const migrations: Record<string, MigrationDigestEntry> = {};

  for (const file of files) {
    const relPath = relative(migrationsDir, file).replace(/\\/g, "/");
    const content = readFileSync(file);
    const digest = computeMigrationDigest(content);
    migrations[relPath] = {
      path: relPath,
      digest,
      byteLength: content.length,
    };
  }

  return {
    version: 1,
    algorithm: "sha256",
    generatedAt: new Date().toISOString(),
    migrations,
  };
}

/**
 * Saves a migration manifest to disk as formatted JSON.
 */
export function saveMigrationManifest(manifestPath: string, manifest: MigrationManifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Loads a migration manifest from disk.
 */
export function loadMigrationManifest(manifestPath: string): MigrationManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Migration manifest not found at: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as MigrationManifest;
}

/**
 * Verifies that all committed migrations match their reviewed digests in the manifest.
 *
 * Security & Reliability guarantees:
 * 1. Historical migrations cannot be modified post-review.
 * 2. Unreviewed modifications are blocked before deployment.
 * 3. New migrations are permitted and reported safely.
 * 4. Diagnostics never leak database credentials, connection strings, or SQL contents.
 */
export function verifyMigrationIntegrity(options: {
  migrationsDir: string;
  manifestPath: string;
  allowNewMigrations?: boolean;
}): VerificationResult {
  const { migrationsDir, manifestPath, allowNewMigrations = true } = options;

  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      totalHistorical: 0,
      totalVerified: 0,
      newMigrationsCount: 0,
      diagnostics: [],
      errors: [`Manifest file does not exist at: ${manifestPath}`],
    };
  }

  const manifest = loadMigrationManifest(manifestPath);
  const currentFiles = discoverMigrationFiles(migrationsDir);
  const currentFileSet = new Set(
    currentFiles.map((f) => relative(migrationsDir, f).replace(/\\/g, "/")),
  );

  const diagnostics: VerificationDiagnostic[] = [];
  const errors: string[] = [];
  let totalVerified = 0;
  let newMigrationsCount = 0;

  // 1. Check all historical migrations in manifest
  for (const [relPath, entry] of Object.entries(manifest.migrations)) {
    const fullPath = join(migrationsDir, relPath);

    if (!existsSync(fullPath)) {
      diagnostics.push({
        path: relPath,
        status: "MISSING",
        expectedDigest: entry.digest,
        message: `Historical migration missing from disk: ${relPath}`,
      });
      errors.push(`Integrity failure: historical migration missing [${relPath}]`);
      continue;
    }

    const content = readFileSync(fullPath);
    const actualDigest = computeMigrationDigest(content);

    if (actualDigest !== entry.digest) {
      diagnostics.push({
        path: relPath,
        status: "MODIFIED",
        expectedDigest: entry.digest,
        actualDigest,
        message: `Historical migration digest mismatch: expected ${entry.digest.slice(0, 12)}... but got ${actualDigest.slice(0, 12)}...`,
      });
      errors.push(
        `Integrity failure: historical migration modified [${relPath}]. Expected: ${entry.digest.slice(0, 12)}... Actual: ${actualDigest.slice(0, 12)}...`,
      );
    } else {
      diagnostics.push({
        path: relPath,
        status: "OK",
        expectedDigest: entry.digest,
        actualDigest,
        message: "Digest matches reviewed manifest",
      });
      totalVerified++;
    }
  }

  // 2. Detect any newly added migrations not yet in manifest
  for (const currentRelPath of currentFileSet) {
    if (!manifest.migrations[currentRelPath]) {
      newMigrationsCount++;
      const fullPath = join(migrationsDir, currentRelPath);
      const actualDigest = computeMigrationDigest(readFileSync(fullPath));

      diagnostics.push({
        path: currentRelPath,
        status: "NEW",
        actualDigest,
        message: "New migration introduced; requires manifest update upon review.",
      });

      if (!allowNewMigrations) {
        errors.push(`Unreviewed new migration found: [${currentRelPath}]`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    totalHistorical: Object.keys(manifest.migrations).length,
    totalVerified,
    newMigrationsCount,
    diagnostics,
    errors,
  };
}
