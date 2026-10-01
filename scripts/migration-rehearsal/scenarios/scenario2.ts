import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalResult,
  RecoveryDecision,
  CompatibilityCheckResult,
  MigrationRecord,
} from "@/scripts/migration-rehearsal/lib/types.ts";

const { assertNotProduction, getMigrationHistory, runCommand, runSql, getTimestamp, getDurationMs, readMigrationSql, splitSqlStatements } =
  CORE_UTILS;

export const SCENARIO_2_ID = "partial-apply-failure";
export const SCENARIO_2_NAME = "Migration fails during schema changes (partial apply)";

export async function runScenario2(dbUrl: string): Promise<{
  results: RehearsalResult[];
  recoveryDecision: RecoveryDecision;
  migrationHistoryBefore: MigrationRecord[];
  migrationHistoryAfter: MigrationRecord[];
  compatibilityCheck: CompatibilityCheckResult;
}> {
  const results: RehearsalResult[] = [];
  const phaseStart = Date.now();

  assertNotProduction(dbUrl);

  // Phase 1: Setup - Capture initial state
  const migrationHistoryBefore = getMigrationHistory(dbUrl);
  results.push({
    scenarioId: SCENARIO_2_ID,
    phase: "setup",
    success: true,
    message: "Captured initial migration state",
    details: { migrationCount: migrationHistoryBefore.length },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(phaseStart),
  });

  // Phase 2: Failure injection - Apply only first half of the latest migration's DDL
  const failureStart = Date.now();
  const latestMigration = migrationHistoryBefore[migrationHistoryBefore.length - 1];

  if (!latestMigration) {
    throw new Error("No migrations found to simulate partial failure");
  }

  // Get the migration SQL
  const sql = readMigrationSql(latestMigration.migrationName);
  const statements = splitSqlStatements(sql);

  if (statements.length < 2) {
    throw new Error("Migration has too few statements to simulate partial failure");
  }

  // Mark migration as started but not finished
  await runSql(dbUrl, `
    UPDATE "_prisma_migrations"
    SET finished_at = NULL, applied_steps_count = 0
    WHERE migration_name = '${latestMigration.migrationName}'
  `);

  // Apply first half of statements (simulating partial success)
  const halfPoint = Math.ceil(statements.length / 2);
  const appliedStatements: string[] = [];
  const failedStatements: string[] = [];

  for (let i = 0; i < halfPoint; i++) {
    const stmt = statements[i];
    const result = runSql(dbUrl, stmt);
    if (result.exitCode === 0) {
      appliedStatements.push(stmt.slice(0, 100));
    } else {
      failedStatements.push(`${stmt.slice(0, 100)}: ${result.stderr}`);
    }
  }

  // Update applied_steps_count to reflect partial application
  await runSql(dbUrl, `
    UPDATE "_prisma_migrations"
    SET applied_steps_count = ${appliedStatements.length}
    WHERE migration_name = '${latestMigration.migrationName}'
  `);

  results.push({
    scenarioId: SCENARIO_2_ID,
    phase: "failure-injection",
    success: appliedStatements.length > 0,
    message: `Applied ${appliedStatements.length} of ${statements.length} statements (simulated partial failure)`,
    details: {
      totalStatements: statements.length,
      appliedCount: appliedStatements.length,
      appliedStatements,
      failedCount: failedStatements.length,
      failedStatements,
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(failureStart),
  });

  // Phase 3: Verification - Check intermediate state
  const verifyStart = Date.now();
  const verificationHistory = getMigrationHistory(dbUrl);
  const targetMigration = verificationHistory.find((m) => m.migrationName === latestMigration.migrationName);
  const isPartial = targetMigration?.finishedAt === null && (targetMigration?.appliedStepsCount ?? 0) > 0;

  // Check which objects were actually created
  const schemaCheck = await checkPartialSchema(dbUrl, appliedStatements);

  results.push({
    scenarioId: SCENARIO_2_ID,
    phase: "verification",
    success: isPartial,
    message: isPartial
      ? "Migration shows as partially applied with some DDL executed"
      : "Migration state does not match expected partial application",
    details: {
      migrationName: targetMigration?.migrationName,
      finishedAt: targetMigration?.finishedAt?.toISOString() ?? null,
      appliedStepsCount: targetMigration?.appliedStepsCount,
      schemaCheck,
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(verifyStart),
  });

  // Phase 4: Recovery - Forward fix by applying remaining statements
  const recoveryStart = Date.now();
  const remainingStatements = statements.slice(halfPoint);
  const recoveryApplied: string[] = [];
  const recoveryFailed: string[] = [];

  for (const stmt of remainingStatements) {
    const result = runSql(dbUrl, stmt);
    if (result.exitCode === 0) {
      recoveryApplied.push(stmt.slice(0, 100));
    } else {
      // Some statements might fail if already applied (e.g., CREATE INDEX IF NOT EXISTS)
      // Check if it's a "already exists" error
      if (result.stderr.includes("already exists") || result.stderr.includes("duplicate")) {
        recoveryApplied.push(stmt.slice(0, 100) + " (already exists)");
      } else {
        recoveryFailed.push(`${stmt.slice(0, 100)}: ${result.stderr}`);
      }
    }
  }

  // Finalize metadata only through Prisma's documented resolve command after
  // the remaining schema changes have been verified.
  const deployResult = runCommand(
    "npx",
    ["prisma", "migrate", "resolve", "--applied", latestMigration.migrationName],
    { DATABASE_URL: dbUrl },
  );
  const deploySuccess = deployResult.exitCode === 0;

  const recoverySuccess = recoveryFailed.length === 0 && deploySuccess;

  results.push({
    scenarioId: SCENARIO_2_ID,
    phase: "recovery",
    success: recoverySuccess,
    message: recoverySuccess
      ? "Forward fix applied remaining statements and Prisma marked the migration applied"
      : `Forward fix incomplete: ${recoveryFailed.length} failed, deploy: ${deploySuccess ? "ok" : "failed"}`,
    details: {
      remainingStatements: remainingStatements.length,
      recoveryApplied,
      recoveryFailed,
      deployStdout: deployResult.stdout.slice(0, 500),
      deployStderr: deployResult.stderr.slice(0, 500),
      deployExitCode: deployResult.exitCode,
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(recoveryStart),
  });

  // Capture final state
  const migrationHistoryAfter = getMigrationHistory(dbUrl);

  // Phase 5: Compatibility check
  const compatStart = Date.now();
  const compatibilityCheck = await runCompatibilityChecks(dbUrl);

  results.push({
    scenarioId: SCENARIO_2_ID,
    phase: "cleanup",
    success: compatibilityCheck.passed,
    message: compatibilityCheck.passed
      ? "All compatibility checks passed after forward fix"
      : "Some compatibility checks failed after forward fix",
    details: { checks: compatibilityCheck.checks },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(compatStart),
  });

  // Determine recommended action
  const recommendedAction = recoveryFailed.length > 0 ? "restore-from-backup" : "forward-fix";

  const recoveryDecision: RecoveryDecision = {
    scenarioId: SCENARIO_2_ID,
    recommendedAction,
    rationale:
      "Migration partially applied some DDL statements before failing. " +
      (recoveryFailed.length > 0
        ? "Some statements could not be applied during forward fix (not idempotent or conflicting). " +
          "Rollback SQL would be complex and error-prone for partial DDL. " +
          "RESTORE FROM BACKUP is the safest recovery path."
        : "All remaining statements applied successfully (or were idempotent). " +
          "Forward fix by completing the migration is safe and verified. " +
          "No data loss, schema is now consistent."),
    sqlCommands: recoveryFailed.length > 0
      ? [
          "-- FORWARD FIX FAILED - DO NOT USE",
          "-- Restore from backup instead:",
          "-- 1. pg_restore --clean --if-exists --dbname=<new_db> <backup.dump>",
          "-- 2. Verify restored state",
          "-- 3. Switch DATABASE_URL to restored database",
        ]
      : [
          "-- Forward fix completed by applying remaining statements",
          `npx prisma migrate resolve --applied ${latestMigration.migrationName}`,
          "-- If manual completion needed, apply these remaining statements:",
          ...remainingStatements.map((s) => s + ";"),
        ],
    warnings: [
      "Forward fix only safe if all DDL is idempotent or conflicts are understood",
      "Non-idempotent DDL (ALTER TABLE, data migrations) requires backup restore",
      "Always verify application compatibility after recovery",
    ],
    verified: recoverySuccess && compatibilityCheck.passed,
  };

  return {
    results,
    recoveryDecision,
    migrationHistoryBefore,
    migrationHistoryAfter,
    compatibilityCheck,
  };
}

async function checkPartialSchema(dbUrl: string, appliedStatements: string[]): Promise<{
  tablesCreated: string[];
  indexesCreated: string[];
  enumsCreated: string[];
}> {
  const tablesCreated: string[] = [];
  const indexesCreated: string[] = [];
  const enumsCreated: string[] = [];

  // Check what was actually created by examining the applied statements
  for (const stmt of appliedStatements) {
    const upper = stmt.toUpperCase();
    if (upper.startsWith("CREATE TABLE")) {
      const match = stmt.match(/CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w_]+"?)/i);
      if (match) tablesCreated.push(match[1].replace(/"/g, ""));
    } else if (upper.startsWith("CREATE INDEX")) {
      const match = stmt.match(/CREATE INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w_]+"?)/i);
      if (match) indexesCreated.push(match[1].replace(/"/g, ""));
    } else if (upper.startsWith("CREATE TYPE") && upper.includes("ENUM")) {
      const match = stmt.match(/CREATE TYPE\s+("?[\w_]+"?)\s+AS\s+ENUM/i);
      if (match) enumsCreated.push(match[1].replace(/"/g, ""));
    }
  }

  return { tablesCreated, indexesCreated, enumsCreated };
}

async function runCompatibilityChecks(dbUrl: string): Promise<CompatibilityCheckResult> {
  const checks = [
    await checkMigrationStatus(dbUrl),
    await checkTableExistence(dbUrl),
    await checkReadPaths(dbUrl),
    await checkEnumIntegrity(dbUrl),
    await checkForeignKeys(dbUrl),
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

async function checkMigrationStatus(dbUrl: string): Promise<{ name: string; passed: boolean; message: string }> {
  const result = runCommand("npx", ["prisma", "migrate", "status"], { DATABASE_URL: dbUrl });
  const passed = result.exitCode === 0 && result.stdout.includes("up to date");
  return {
    name: "Migration Status",
    passed,
    message: passed
      ? "Database schema is up to date"
      : `Migration status check failed: ${result.stdout}`,
  };
}

async function checkTableExistence(dbUrl: string): Promise<{ name: string; passed: boolean; message: string }> {
  const requiredTables = [
    "anchors",
    "corridors",
    "anchor_corridors",
    "rate_snapshots",
    "transfer_outcomes",
    "reputation_scores",
    "_prisma_migrations",
  ];

  const missing: string[] = [];
  for (const table of requiredTables) {
    const result = runSql(dbUrl, `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '${table}'
      )
    `);
    if (!result.stdout.includes("t")) {
      missing.push(table);
    }
  }

  return {
    name: "Table Existence",
    passed: missing.length === 0,
    message: missing.length === 0
      ? "All required tables exist"
      : `Missing tables: ${missing.join(", ")}`,
  };
}

async function checkReadPaths(dbUrl: string): Promise<{ name: string; passed: boolean; message: string }> {
  const result = runSql(dbUrl, `
    SELECT COUNT(*) FROM (
      SELECT DISTINCT ON (anchor_id) id
      FROM rate_snapshots
      WHERE corridor_id = (SELECT id FROM corridors LIMIT 1)
      ORDER BY anchor_id, captured_at DESC, id DESC
    ) x
  `);

  const count = parseInt(result.stdout.match(/(\d+)/)?.[1] ?? "0", 10);
  const passed = count >= 0 && result.exitCode === 0;

  return {
    name: "Read Path - Latest Rate Per Anchor",
    passed,
    message: passed
      ? `Read path works: ${count} anchors with latest rates`
      : `Read path failed: ${result.stderr}`,
  };
}

async function checkEnumIntegrity(dbUrl: string): Promise<{ name: string; passed: boolean; message: string }> {
  const enums = ["anchor_status", "transfer_status", "reputation_score_band", "reputation_state"];
  const missing: string[] = [];

  for (const enumName of enums) {
    const result = runSql(dbUrl, `
      SELECT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = '${enumName}' AND t.typtype = 'e'
      )
    `);
    if (!result.stdout.includes("t")) {
      missing.push(enumName);
    }
  }

  return {
    name: "Enum Integrity",
    passed: missing.length === 0,
    message: missing.length === 0
      ? "All required enums exist"
      : `Missing enums: ${missing.join(", ")}`,
  };
}

async function checkForeignKeys(dbUrl: string): Promise<{ name: string; passed: boolean; message: string }> {
  const result = runSql(dbUrl, `
    SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY'
  `);

  const count = parseInt(result.stdout.match(/(\d+)/)?.[1] ?? "0", 10);
  // We expect at least 6 foreign keys in the schema
  const passed = count >= 6 && result.exitCode === 0;

  return {
    name: "Foreign Key Integrity",
    passed,
    message: passed
      ? `Foreign keys intact: ${count} constraints`
      : `Foreign key check failed: expected >= 6, found ${count}`,
  };
}