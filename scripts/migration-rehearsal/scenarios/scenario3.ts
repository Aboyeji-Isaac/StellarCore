import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalResult,
  RecoveryDecision,
  CompatibilityCheckResult,
  MigrationRecord,
} from "@/scripts/migration-rehearsal/lib/types.ts";

const { assertNotProduction, getMigrationHistory, runCommand, runSql, getTimestamp, getDurationMs, readMigrationSql, splitSqlStatements } =
  CORE_UTILS;

export const SCENARIO_3_ID = "post-schema-checksum-mismatch";
export const SCENARIO_3_NAME = "Migration fails after schema changes (checksum mismatch)";

export async function runScenario3(dbUrl: string): Promise<{
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
    scenarioId: SCENARIO_3_ID,
    phase: "setup",
    success: true,
    message: "Captured initial migration state",
    details: { migrationCount: migrationHistoryBefore.length },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(phaseStart),
  });

  // Phase 2: Failure injection - Apply all DDL but corrupt the checksum
  const failureStart = Date.now();
  const latestMigration = migrationHistoryBefore[migrationHistoryBefore.length - 1];

  if (!latestMigration) {
    throw new Error("No migrations found to simulate checksum mismatch");
  }

  // Get the migration SQL and apply ALL statements (schema is correct)
  const sql = readMigrationSql(latestMigration.migrationName);
  const statements = splitSqlStatements(sql);

  for (const stmt of statements) {
    const result = runSql(dbUrl, stmt);
    // Ignore "already exists" errors since we're applying to a DB that already has the migration
    if (result.exitCode !== 0 && !result.stderr.includes("already exists") && !result.stderr.includes("duplicate")) {
      throw new Error(`Failed to apply DDL: ${stmt.slice(0, 100)} - ${result.stderr}`);
    }
  }

  // Now corrupt the checksum in _prisma_migrations
  const corruptedChecksum = "0000000000000000000000000000000000000000000000000000000000000000";
  await runSql(dbUrl, `
    UPDATE "_prisma_migrations"
    SET checksum = '${corruptedChecksum}',
        finished_at = NULL,
        applied_steps_count = ${statements.length}
    WHERE migration_name = '${latestMigration.migrationName}'
  `);

  results.push({
    scenarioId: SCENARIO_3_ID,
    phase: "failure-injection",
    success: true,
    message: "Applied all DDL but corrupted migration checksum to simulate metadata mismatch",
    details: {
      migrationName: latestMigration.migrationName,
      statementsApplied: statements.length,
      corruptedChecksum: corruptedChecksum.slice(0, 16) + "...",
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(failureStart),
  });

  // Phase 3: Verification - Check that schema is correct but metadata is wrong
  const verifyStart = Date.now();
  const verificationHistory = getMigrationHistory(dbUrl);
  const targetMigration = verificationHistory.find((m) => m.migrationName === latestMigration.migrationName);
  const hasChecksumMismatch = targetMigration?.checksum === corruptedChecksum;

  // Verify schema is actually correct by checking tables/enums
  const schemaCorrect = await verifySchemaCorrect(dbUrl, statements);

  // Check what Prisma migrate status says
  const statusResult = runCommand("npx", ["prisma", "migrate", "status"], { DATABASE_URL: dbUrl });
  const prismaDetectsMismatch = statusResult.exitCode !== 0 || statusResult.stdout.includes("mismatch") || statusResult.stdout.includes("dirty");

  results.push({
    scenarioId: SCENARIO_3_ID,
    phase: "verification",
    success: hasChecksumMismatch && schemaCorrect && prismaDetectsMismatch,
    message:
      hasChecksumMismatch && schemaCorrect && prismaDetectsMismatch
        ? "Schema is correct but Prisma detects checksum mismatch (metadata corruption)"
        : "Verification failed - state does not match expected checksum mismatch scenario",
    details: {
      migrationName: targetMigration?.migrationName,
      checksum: targetMigration?.checksum?.slice(0, 16) + "...",
      expectedCorrupted: corruptedChecksum.slice(0, 16) + "...",
      schemaCorrect,
      prismaStatusExitCode: statusResult.exitCode,
      prismaStatusOutput: statusResult.stdout.slice(0, 300),
    },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(verifyStart),
  });

  // Phase 4: Recovery - repair metadata only through Prisma's documented
  // migrate resolve command after schema verification. Never hand-edit the
  // checksum as an operational recovery procedure.
  const recoveryStart = Date.now();
  const resolveResult = runCommand(
    "npx",
    ["prisma", "migrate", "resolve", "--applied", latestMigration.migrationName],
    { DATABASE_URL: dbUrl },
  );
  const verifyFixResult = runCommand(
    "npx",
    ["prisma", "migrate", "status"],
    { DATABASE_URL: dbUrl },
  );
  const fixSuccess =
    resolveResult.exitCode === 0 &&
    verifyFixResult.exitCode === 0 &&
    verifyFixResult.stdout.toLowerCase().includes("up to date");

  results.push({
    scenarioId: SCENARIO_3_ID,
    phase: "recovery",
    success: fixSuccess,
    message: fixSuccess
      ? "Migration metadata repaired with 'prisma migrate resolve --applied'"
      : "Prisma metadata repair or post-repair status verification failed",
    details: {
      resolveExitCode: resolveResult.exitCode,
      resolveStdout: resolveResult.stdout.slice(0, 300),
      resolveStderr: resolveResult.stderr.slice(0, 300),
      verifyExitCode: verifyFixResult.exitCode,
      verifyStdout: verifyFixResult.stdout.slice(0, 300),
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
    scenarioId: SCENARIO_3_ID,
    phase: "cleanup",
    success: compatibilityCheck.passed,
    message: compatibilityCheck.passed
      ? "All compatibility checks passed after checksum repair"
      : "Some compatibility checks failed after checksum repair",
    details: { checks: compatibilityCheck.checks },
    timestamp: getTimestamp(),
    durationMs: getDurationMs(compatStart),
  });

  const recoveryDecision: RecoveryDecision = {
    scenarioId: SCENARIO_3_ID,
    recommendedAction: "forward-fix",
    rationale:
      "All DDL is verified present, but migration metadata is unfinished/corrupt. " +
      "Repair metadata only through Prisma's documented migrate resolve command after schema verification.",
    sqlCommands: [
      `npx prisma migrate resolve --applied ${latestMigration.migrationName}`,
    ],
    warnings: [
      "Only safe when schema is verified correct (all DDL applied)",
      "Never use this to hide actual schema drift - verify schema first",
      "If schema is actually incorrect, restore from backup instead",
    ],
    verified: fixSuccess && compatibilityCheck.passed,
  };

  return {
    results,
    recoveryDecision,
    migrationHistoryBefore,
    migrationHistoryAfter,
    compatibilityCheck,
  };
}

async function verifySchemaCorrect(dbUrl: string, statements: string[]): Promise<boolean> {
  // Verify that all expected objects from the migration exist
  for (const stmt of statements) {
    const upper = stmt.toUpperCase().trim();
    if (upper.startsWith("CREATE TABLE")) {
      const match = stmt.match(/CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w_]+"?)/i);
      if (match) {
        const table = match[1].replace(/"/g, "");
        const result = runSql(dbUrl, `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${table}')`);
        if (!result.stdout.includes("t")) return false;
      }
    } else if (upper.startsWith("CREATE INDEX")) {
      // Indexes are optional for correctness check
    } else if (upper.startsWith("CREATE TYPE") && upper.includes("ENUM")) {
      const match = stmt.match(/CREATE TYPE\s+("?[\w_]+"?)\s+AS\s+ENUM/i);
      if (match) {
        const enumName = match[1].replace(/"/g, "");
        const result = runSql(dbUrl, `
          SELECT EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typname = '${enumName}' AND t.typtype = 'e'
          )
        `);
        if (!result.stdout.includes("t")) return false;
      }
    }
  }
  return true;
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