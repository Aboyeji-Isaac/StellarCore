import type {
  CaptureRunCompletion,
  CaptureRunIdentity,
  CaptureRunLineageRepository,
  CaptureRunOutcome,
  LatestScheduledCaptureRun,
} from "@/types/scheduling";

/**
 * Schedulers that are driven by an approved deployment schedule. The manual
 * operator CLI is excluded on purpose so it can never make the cadence-health
 * signal look healthier than the scheduled process really is.
 */
const SCHEDULED_SCHEDULERS = Object.freeze(["vercel-cron", "external"]);

const OUTCOME_TO_DATABASE = Object.freeze({
  succeeded: "SUCCEEDED",
  partial: "PARTIAL",
  failed: "FAILED",
  skipped: "SKIPPED",
} as const) satisfies Readonly<Record<CaptureRunOutcome, string>>;

const OUTCOME_FROM_DATABASE = Object.freeze({
  SUCCEEDED: "succeeded",
  PARTIAL: "partial",
  FAILED: "failed",
  SKIPPED: "skipped",
}) as Readonly<Record<string, CaptureRunOutcome>>;

/**
 * Durable capture-run ledger: run identity, configuration lineage, cadence that
 * was planned, and the sanitized outcome. Persists no payloads, prices, URLs,
 * headers, or errors.
 */
export const PRISMA_CAPTURE_RUN_REPOSITORY: CaptureRunLineageRepository =
  Object.freeze({
  async startRun(input: CaptureRunIdentity): Promise<void> {
    const { db } = await import("@/lib/dbClient");
    await db.rateCaptureRun.create({
      data: {
        runId: input.runId,
        contractVersion: input.contractVersion,
        configurationFingerprint: input.configurationFingerprint,
        scheduler: input.scheduler,
        scheduledIntervalMs: input.scheduledIntervalMs,
        scheduledAt: input.scheduledAt,
        startedAt: input.startedAt,
        outcome: "SKIPPED",
      },
    });
  },

  async completeRun(input: CaptureRunCompletion): Promise<void> {
    const { db } = await import("@/lib/dbClient");
    await db.rateCaptureRun.update({
      where: { runId: input.runId },
      data: {
        outcome: OUTCOME_TO_DATABASE[input.outcome],
        completedAt: input.completedAt,
        attempted: input.attempted,
        succeeded: input.succeeded,
        failed: input.failed,
        skipped: input.skipped,
        failureCodes: [...input.failureCodes],
      },
    });
  },

  async findLatestCompletedScheduledRun(): Promise<LatestScheduledCaptureRun | null> {
    const { db } = await import("@/lib/dbClient");
    const row = await db.rateCaptureRun.findFirst({
      where: {
        scheduler: { in: [...SCHEDULED_SCHEDULERS] },
        completedAt: { not: null },
      },
      orderBy: { completedAt: "desc" },
      select: {
        runId: true,
        completedAt: true,
        scheduledIntervalMs: true,
        outcome: true,
      },
    });
    if (!row?.completedAt) return null;

    return Object.freeze({
      runId: row.runId,
      completedAt: row.completedAt,
      scheduledIntervalMs: row.scheduledIntervalMs,
      outcome: OUTCOME_FROM_DATABASE[row.outcome] ?? "skipped",
    });
  },
});
