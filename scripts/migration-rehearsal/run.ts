import "dotenv/config";
import { pathToFileURL } from "node:url";
import { exit } from "node:process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CORE_UTILS } from "./lib/core.ts";
import { runScenario1 } from "./scenarios/scenario1.ts";
import { runScenario2 } from "./scenarios/scenario2.ts";
import { runScenario3 } from "./scenarios/scenario3.ts";
import type { RehearsalReport, RehearsalResult, RecoveryDecision } from "./lib/types.ts";

const { REPO_ROOT } = CORE_UTILS;

interface ScenarioRunner {
  id: string;
  name: string;
  run: (dbUrl: string) => Promise<{
    results: RehearsalResult[];
    recoveryDecision: RecoveryDecision;
    migrationHistoryBefore: MigrationRecord[];
    migrationHistoryAfter: MigrationRecord[];
    compatibilityCheck: CompatibilityCheckResult;
  }>;
}

import type { MigrationRecord, CompatibilityCheckResult } from "./lib/types.ts";

const SCENARIOS: ScenarioRunner[] = [
  { id: "pre-schema-failure", name: "Migration fails before schema changes (idempotent)", run: runScenario1 },
  { id: "partial-apply-failure", name: "Migration fails during schema changes (partial apply)", run: runScenario2 },
  { id: "post-schema-checksum-mismatch", name: "Migration fails after schema changes (checksum mismatch)", run: runScenario3 },
];

async function runScenario(scenario: ScenarioRunner, dbUrl: string): Promise<RehearsalReport> {
  const startedAt = new Date().toISOString();
  console.log(`\n=== Running Scenario: ${scenario.name} ===`);

  const {
    results,
    recoveryDecision,
    migrationHistoryBefore,
    migrationHistoryAfter,
    compatibilityCheck,
  } = await scenario.run(dbUrl);

  const completedAt = new Date().toISOString();
  const overallSuccess = results.every((r) => r.success) && recoveryDecision.verified && compatibilityCheck.passed;

  const report: RehearsalReport = {
    scenarioId: scenario.id,
    startedAt,
    completedAt,
    overallSuccess,
    phases: results,
    recoveryDecision,
    migrationHistoryBefore,
    migrationHistoryAfter,
    compatibilityCheck,
  };

  return report;
}

function printScenarioSummary(report: RehearsalReport): void {
  console.log(`\n--- ${report.scenarioId} Summary ---`);
  console.log(`Overall: ${report.overallSuccess ? "✅ PASSED" : "❌ FAILED"}`);
  console.log(`Started:  ${report.startedAt}`);
  console.log(`Completed: ${report.completedAt}`);

  for (const phase of report.phases) {
    const icon = phase.success ? "✅" : "❌";
    console.log(`  ${icon} ${phase.phase}: ${phase.message}`);
  }

  console.log(`\nRecovery Decision: ${report.recoveryDecision.recommendedAction}`);
  console.log(`Rationale: ${report.recoveryDecision.rationale}`);
  console.log(`Verified: ${report.recoveryDecision.verified ? "Yes" : "No"}`);

  if (report.recoveryDecision.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of report.recoveryDecision.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  console.log(`\nCompatibility: ${report.compatibilityCheck.passed ? "✅ PASSED" : "❌ FAILED"}`);
  for (const check of report.compatibilityCheck.checks) {
    const icon = check.passed ? "✅" : "❌";
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioFilter = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    console.error("Usage: DATABASE_URL=postgresql://... npx tsx scripts/migration-rehearsal/run.ts [--scenario=<id>] [--dry-run]");
    exit(1);
  }

  console.log("Migration Recovery Rehearsal Framework");
  console.log("========================================");
  console.log(`Repository: ${REPO_ROOT}`);
  console.log(`Database: ${databaseUrl.replace(/:[^:@]*@/, ":****@")}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);

  if (dryRun) {
    console.log("\nDry run mode - no database changes will be made");
    exit(0);
  }

  // Safety check
  try {
    const { assertNotProduction } = CORE_UTILS;
    assertNotProduction(databaseUrl);
  } catch (e) {
    console.error(`\n❌ SAFETY VIOLATION: ${e}`);
    exit(1);
  }

  const scenariosToRun = scenarioFilter
    ? SCENARIOS.filter((s) => s.id === scenarioFilter)
    : SCENARIOS;

  if (scenariosToRun.length === 0) {
    console.error(`\n❌ No scenario found matching: ${scenarioFilter}`);
    exit(1);
  }

  console.log(`\nRunning ${scenariosToRun.length} scenario(s)...`);

  const reports: RehearsalReport[] = [];
  let overallSuccess = true;

  for (const scenario of scenariosToRun) {
    try {
      const report = await runScenario(scenario, databaseUrl);
      reports.push(report);
      printScenarioSummary(report);
      if (!report.overallSuccess) overallSuccess = false;
    } catch (e) {
      console.error(`\n❌ Scenario ${scenario.id} failed with error:`, e);
      overallSuccess = false;
    }
  }

  // Print overall summary
  console.log("\n========================================");
  console.log("OVERALL SUMMARY");
  console.log("========================================");
  console.log(`Scenarios run: ${reports.length}`);
  console.log(`Passed: ${reports.filter((r) => r.overallSuccess).length}`);
  console.log(`Failed: ${reports.filter((r) => !r.overallSuccess).length}`);
  console.log(`Overall: ${overallSuccess ? "✅ ALL PASSED" : "❌ SOME FAILED"}`);

  // Print recovery decisions summary
  console.log("\n--- Recovery Decisions ---");
  for (const report of reports) {
    const rd = report.recoveryDecision;
    console.log(`${report.scenarioId}: ${rd.recommendedAction.toUpperCase()} (verified: ${rd.verified ? "yes" : "no"})`);
    console.log(`  ${rd.rationale}`);
  }

  // Save combined report
  const combinedReport = {
    generatedAt: new Date().toISOString(),
    repository: REPO_ROOT,
    database: databaseUrl.replace(/:[^:@]*@/, ":****@"),
    scenarios: reports,
    overallSuccess,
  };

  const reportsDir = join(REPO_ROOT, "scripts", "migration-rehearsal", "reports");
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  const combinedFile = join(reportsDir, `combined-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(combinedFile, JSON.stringify(combinedReport, null, 2));
  console.log(`\nCombined report saved to: ${combinedFile}`);

  exit(overallSuccess ? 0 : 1);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    exit(1);
  });
}