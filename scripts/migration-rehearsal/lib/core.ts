import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type {
  MigrationRecord,
  RehearsalReport,
  DatabaseStateSnapshot,
} from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REPORTS_DIR = join(__dirname, "reports");

const PRODUCTION_INDICATORS = [
  "prod",
  "production",
  "live",
  "main",
  "primary",
  "aws",
  "gcp",
  "azure",
  "vercel",
  "supabase",
  "neon",
  "planetscale",
];

function assertNotProduction(dbUrl: string): void {
  const url = new URL(dbUrl);
  const host = url.hostname.toLowerCase();

  for (const indicator of PRODUCTION_INDICATORS) {
    if (host.includes(indicator)) {
      throw new Error(
        `SAFETY VIOLATION: Database host "${host}" appears to be production. ` +
          `Migration rehearsals must run against isolated non-production databases only.`,
      );
    }
  }

  if (url.searchParams.get("sslmode") === "require" && host.includes("prisma")) {
    throw new Error(
      `SAFETY VIOLATION: Database appears to be a managed Prisma production instance. ` +
        `Migration rehearsals must run against isolated non-production databases only.`,
    );
  }
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function getDurationMs(start: number): number {
  return Date.now() - start;
}

function runCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string = REPO_ROOT,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env },
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

function runSql(dbUrl: string, sql: string): { stdout: string; stderr: string; exitCode: number } {
  return runCommand("psql", [dbUrl, "-c", sql], { DATABASE_URL: dbUrl });
}

function getMigrationHistory(dbUrl: string): MigrationRecord[] {
  const result = runCommand(
    "npx",
    ["prisma", "migrate", "status", "--json"],
    { DATABASE_URL: dbUrl },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to get migration status: ${result.stderr}`);
  }

  try {
    const data = JSON.parse(result.stdout);
    return (data.appliedMigrations ?? []).map((m: unknown) => ({
      id: String((m as Record<string, unknown>).migration_name ?? ""),
      checksum: String((m as Record<string, unknown>).checksum ?? ""),
      finishedAt: (m as Record<string, unknown>).finished_at
        ? new Date(String((m as Record<string, unknown>).finished_at))
        : null,
      migrationName: String((m as Record<string, unknown>).migration_name ?? ""),
      logs: String((m as Record<string, unknown>).logs ?? ""),
      rolledBackAt: (m as Record<string, unknown>).rolled_back_at
        ? new Date(String((m as Record<string, unknown>).rolled_back_at))
        : null,
      startedAt: new Date(String((m as Record<string, unknown>).started_at ?? Date.now())),
      appliedStepsCount: Number((m as Record<string, unknown>).applied_steps_count ?? 0),
    }));
  } catch {
    return [];
  }
}

function getTableRowCounts(dbUrl: string): Record<string, number> {
  const tables = [
    "anchors",
    "corridors",
    "anchor_corridors",
    "rate_snapshots",
    "transfer_outcomes",
    "reputation_scores",
    "_prisma_migrations",
  ];

  const counts: Record<string, number> = {};

  for (const table of tables) {
    const result = runSql(dbUrl, `SELECT COUNT(*) FROM "${table}"`);
    const match = result.stdout.match(/(\d+)/);
    counts[table] = match ? parseInt(match[1], 10) : -1;
  }

  return counts;
}

function getSchemaHash(dbUrl: string): string {
  const result = runSql(
    dbUrl,
    `SELECT string_agg(table_name || ':' || column_name || ':' || data_type, '|' ORDER BY table_name, ordinal_position)
     FROM information_schema.columns
     WHERE table_schema = 'public'`,
  );

  const hash = createHash("sha256").update(result.stdout.trim()).digest("hex");
  return hash.slice(0, 16);
}

function snapshotDatabaseState(dbUrl: string): DatabaseStateSnapshot {
  return {
    migrationRecords: getMigrationHistory(dbUrl),
    tableRowCounts: getTableRowCounts(dbUrl),
    schemaHash: getSchemaHash(dbUrl),
  };
}

function ensureReportsDir(): void {
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function writeReport(scenarioId: string, report: RehearsalReport): void {
  ensureReportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = join(REPORTS_DIR, `${scenarioId}-${timestamp}.json`);
  writeFileSync(filename, JSON.stringify(report, null, 2));
}

function readMigrationSql(migrationName: string): string {
  const migrationsDir = join(REPO_ROOT, "prisma", "migrations");
  const entries = readdirSync(migrationsDir);
  const migrationDir = entries.find((d: string) => d.includes(migrationName) || d.endsWith(migrationName));
  if (!migrationDir) {
    throw new Error(`Migration directory not found for: ${migrationName}`);
  }
  const sqlPath = join(migrationsDir, migrationDir, "migration.sql");
  return readFileSync(sqlPath, "utf8");
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

export const CORE_UTILS = Object.freeze({
  assertNotProduction,
  getTimestamp,
  getDurationMs,
  runCommand,
  runSql,
  getMigrationHistory,
  getTableRowCounts,
  getSchemaHash,
  snapshotDatabaseState,
  ensureReportsDir,
  writeReport,
  readMigrationSql,
  splitSqlStatements,
  REPO_ROOT,
  REPORTS_DIR,
});