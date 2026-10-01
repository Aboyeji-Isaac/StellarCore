import type { MigrationRecord } from "./core.ts";

export type RehearsalScenarioId =
  | "pre-schema-failure"
  | "partial-apply-failure"
  | "post-schema-checksum-mismatch";

export type RehearsalPhase = "setup" | "failure-injection" | "verification" | "recovery" | "cleanup";

export type RehearsalResult = Readonly<{
  scenarioId: RehearsalScenarioId;
  phase: RehearsalPhase;
  success: boolean;
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
  durationMs: number;
}>;

export type RecoveryDecision = Readonly<{
  scenarioId: RehearsalScenarioId;
  recommendedAction: "rollback" | "forward-fix" | "restore-from-backup";
  rationale: string;
  sqlCommands: readonly string[];
  warnings: readonly string[];
  verified: boolean;
}>;

export type RehearsalReport = Readonly<{
  scenarioId: RehearsalScenarioId;
  startedAt: string;
  completedAt: string;
  overallSuccess: boolean;
  phases: readonly RehearsalResult[];
  recoveryDecision: RecoveryDecision;
  migrationHistoryBefore: readonly MigrationRecord[];
  migrationHistoryAfter: readonly MigrationRecord[];
  compatibilityCheck: CompatibilityCheckResult;
}>;

export type CompatibilityCheckResult = Readonly<{
  passed: boolean;
  checks: readonly CompatibilityCheck[];
}>;

export type CompatibilityCheck = Readonly<{
  name: string;
  passed: boolean;
  message: string;
}>;

export type DatabaseStateSnapshot = Readonly<{
  migrationRecords: readonly MigrationRecord[];
  tableRowCounts: Record<string, number>;
  schemaHash: string;
}>;