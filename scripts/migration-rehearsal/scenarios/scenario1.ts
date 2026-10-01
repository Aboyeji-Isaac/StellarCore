import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalResult,
  RecoveryDecision,
  CompatibilityCheckResult,
  MigrationRecord,
} from "@/scripts/migration-rehearsal/lib/types.ts";

const { assertNotProduction, getMigrationHistory, runCommand, runSql, getTimestamp, getDurationMs } =
  CORE_UTILS;

export const SCENARIO_1_ID = "pre-schema-failure";
export const SCENARIO_1_NAME = "Migration fails before schema changes (idempotent)";

export async function runScenario1(dbUrl: string): Promise<{
  results: RehearsalResult[];
  recoveryDecision: RecoveryDecision;
  migrationHistoryBefore: MigrationRecord[];
  migrationHistoryAfter: MigrationRecord[];
  compatibilityCheck: CompatibilityCheckResult;
}> {
  const results: RehearsalResult[] = [];
  const phaseStart = Date.now();

  assertNotProduction(dbUrl);

  // Phase 1: Setup - Capture initial migration state
  const migrationHistoryBefore = getMigrationHistory(dbUrl);
  results.push({
    scenarioId: SCENARIO_1_ID,
    phase: "setup",
    success: true,
    message: "Captured initial migration state",
    details: { migrationCount: migrationHistoryBefore.length },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(phaseStart),
  });

  // Phase 2: Failure injection - Simulate migration failing before any schema changes
  // This is done by marking the latest migration as "pending" in _prisma_migrations
  // without actually applying the DDL
  const failureStart = Date.now();
  const latestMigration = migrationHistoryBefore[migrationHistoryBefore.length - 1];

  if (latestMigration) {
    // Mark the latest migration as not finished (simulating failure before DDL)
    await runSql(dbUrl, `
      UPDATE "_prisma_migrations"
      SET finished_at = NULL, applied_steps_count = 0
      WHERE migration_name = '${latestMigration.migrationName}'
    `);
  }

  results.push({
    scenarioId: SCENARIO_1_ID,
    phase: "failure-injection",
    success: true,
    message: "Simulated migration failure before schema changes by clearing finished_at",
    details: { affectedMigration: latestMigration?.migrationName ?? "none" },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(failureStart),
  });

  // Phase 3: Verification - Check that migration shows as pending
  const verifyStart = Date.now();
  const verificationHistory = getMigrationHistory(dbUrl);
  const targetMigration = verificationHistory.find((m) => m.migrationName === latestMigration?.migrationName);
  const isPending = targetMigration?.finishedAt === null;

  results.push({
    scenarioId: SCENARIO_1_ID,
    phase: "verification",
    success: isPending,
    message: isPending
      ? "Migration correctly shows as pending (not finished)"
      : "Migration still shows as finished - failure injection failed",
    details: {
      migrationName: targetMigration?.migrationName,
      finishedAt: targetMigration?.finishedAt?.toISOString() ?? null,
      appliedStepsCount: targetMigration?.appliedStepsCount,
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(verifyStart),
  });

  // Phase 4: Recovery - Simply re-run prisma migrate deploy (idempotent)
  const recoveryStart = Date.now();
  const recoverResult = runCommand("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: dbUrl });
  const recoverySuccess = recoverResult.exitCode === 0;

  results.push({
    scenarioId: SCENARIO_1_ID,
    phase: "recovery",
    success: recoverySuccess,
    message: recoverySuccess
      ? "Migration reapplied successfully via 'prisma migrate deploy'"
      : `Migration reapply failed: ${recoverResult.stderr}`,
    details: {
      stdout: recoverResult.stdout.slice(0, 500),
      stderr: recoverResult.stderr.slice(0, 500),
      exitCode: recoverResult.exitCode,
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
    scenarioId: SCENARIO_1_ID,
    phase: "cleanup",
    success: compatibilityCheck.passed,
    message: compatibilityCheck.passed
      ? "All compatibility checks passed"
      : "Some compatibility checks failed",
    details: { checks: compatibilityCheck.checks },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(compatStart),
  });

  // Create recovery decision record
  const recoveryDecision: RecoveryDecision = {
    scenarioId: SCENARIO_1_ID,
    recommendedAction: "rollback",
    rationale:
      "Migration failed before any DDL executed. The _prisma_migrations record exists but finished_at is NULL. " +
      "Simply re-running 'prisma migrate deploy' will apply the pending migration idempotently. " +
      "No schema changes were made, so rollback is trivial and safe.",
    sqlCommands: [
      "-- No manual SQL needed; 'prisma migrate deploy' handles this idempotently",
      "-- If needed manually: UPDATE _prisma_migrations SET finished_at = NOW() WHERE migration_name = '...'",
    ],
    warnings: [
      "Ensure no concurrent migration runs are in progress",
      "Verify application reads work after recovery",
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

async function runCompatibilityChecks(dbUrl: string): Promise<CompatibilityCheckResult> {
  const checks = [
    await checkMigrationStatus(dbUrl),
    await checkTableExistence(dbUrl),
    await checkReadPaths(dbUrl),
    await checkEnumIntegrity(dbUrl),
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
  // Test the critical read path: latest rate per anchor
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