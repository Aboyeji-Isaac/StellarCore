import {
  RATE_CAPTURE_EXECUTION_BUDGET_MS,
  RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
} from "@/constants/scheduling";
import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";
import { auditDeployedCaptureSchedule, assertDeployedCaptureScheduleIsSafe } from "@/lib/scheduling/deploymentSchedule";
import { resolveSelectedRateCaptureScheduler } from "@/lib/scheduling/captureCadence";
import {
  createCaptureRunIdentity,
  fingerprintReviewedRateConfiguration,
} from "@/lib/scheduled/captureIdentity";
import { PRISMA_CAPTURE_RUN_REPOSITORY } from "@/lib/scheduled/captureRunRepository";
import { POSTGRES_ADVISORY_CAPTURE_LOCK } from "@/lib/scheduled/captureLock";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { RateSnapshotLineage } from "@/types/rates";
import type {
  CaptureLockAcquisition,
  CaptureLockPort,
  CaptureRunLineageRepository,
  CaptureRunOutcome,
  CaptureScheduleAudit,
  RateCaptureRunResult,
  RateCaptureRunState,
  RateCaptureSchedulerSelection,
} from "@/types/scheduling";

export type RateCaptureCaptureOptions = Readonly<{
  lineage: RateSnapshotLineage;
  shouldContinue: () => boolean;
  now: () => Date;
}>;

export type RateCaptureRunDependencies = Readonly<{
  capture: (options: RateCaptureCaptureOptions) => Promise<SafeLiveRateRunSummary>;
  lock: CaptureLockPort;
  lineage: CaptureRunLineageRepository;
  scheduler: () => RateCaptureSchedulerSelection;
  auditSchedule: () => CaptureScheduleAudit;
  configurationFingerprint: () => string;
  now: () => Date;
}>;

/**
 * One bounded, independently authenticated capture invocation.
 *
 * Guarantees, in order:
 *  1. A scheduler must be approved and the checked-in cadence must satisfy the
 *     scheduling contract, otherwise nothing is attempted.
 *  2. Exactly one invocation may work at a time. Overlap is reported as
 *     `already_running` and performs no source work and no persistence.
 *  3. Durable capture-run lineage is written before any source work. If lineage
 *     cannot be written, no observation is persisted.
 *  4. Work stops when the execution budget is spent. Remaining sources are
 *     reported as skipped, never fabricated and never failing the whole run.
 *  5. A failing reviewed source leaves successful independent observations
 *     committed and writes no snapshot for itself.
 *
 * It never computes a median, never calls SEP-38 firm quote, and never touches
 * reputation, which is a separate schedule.
 */
export async function runReviewedRateCapture(
  dependencies: RateCaptureRunDependencies = DEFAULT_DEPENDENCIES,
): Promise<RateCaptureRunResult> {
  const startedAt = dependencies.now();
  const scheduler = dependencies.scheduler();
  const configurationFingerprint = dependencies.configurationFingerprint();

  if (scheduler === "disabled") {
    return result({
      ok: false,
      state: "disabled",
      scheduler,
      configurationFingerprint,
      startedAt,
      completedAt: startedAt,
      errorCode: "CAPTURE_SCHEDULE_DISABLED",
    });
  }

  const audit = dependencies.auditSchedule();
  if (!audit.ok) {
    return result({
      ok: false,
      state: "failed",
      scheduler,
      configurationFingerprint,
      startedAt,
      completedAt: dependencies.now(),
      errorCode: "INCOMPATIBLE_CAPTURE_SCHEDULE",
    });
  }

  const scheduledIntervalMs = audit.intervalMs;
  const acquisition = await acquire(dependencies.lock);
  if (!acquisition.acquired) {
    return result({
      ok: true,
      state: "already_running",
      scheduler,
      configurationFingerprint,
      scheduledIntervalMs,
      startedAt,
      completedAt: dependencies.now(),
      errorCode: acquisition.reason,
    });
  }

  try {
    const identity = createCaptureRunIdentity({
      scheduler,
      startedAt,
      scheduledAt: startedAt,
      scheduledIntervalMs,
      configurationFingerprint,
    });

    try {
      await dependencies.lineage.startRun(identity);
    } catch {
      return result({
        ok: false,
        state: "failed",
        scheduler,
        configurationFingerprint,
        runId: identity.runId,
        scheduledIntervalMs,
        startedAt,
        completedAt: dependencies.now(),
        errorCode: "CAPTURE_RUN_LINEAGE_FAILURE",
      });
    }

    const deadlineMs = startedAt.getTime() + RATE_CAPTURE_EXECUTION_BUDGET_MS;
    let summary: SafeLiveRateRunSummary | null = null;
    try {
      summary = await dependencies.capture({
        lineage: Object.freeze({ captureRunId: identity.runId }),
        shouldContinue: () => dependencies.now().getTime() < deadlineMs,
        now: dependencies.now,
      });
    } catch {
      summary = null;
    }

    const completedAt = dependencies.now();
    const outcome = captureOutcome(summary);

    try {
      await dependencies.lineage.completeRun({
        runId: identity.runId,
        outcome,
        completedAt,
        attempted: summary?.totalAttempted ?? 0,
        succeeded: summary?.succeeded ?? 0,
        failed: summary === null ? 1 : summary.failed,
        skipped: summary?.skipped ?? 0,
        failureCodes: sanitizeFailureCodes(summary),
      });
    } catch {
      // The run row already records that a run started and never completed,
      // which is the truthful state. The capture result is still returned.
    }

    return result({
      ok: summary !== null && outcome !== "failed",
      state: "completed",
      scheduler,
      configurationFingerprint,
      runId: identity.runId,
      scheduledIntervalMs,
      lineageRecorded: true,
      startedAt,
      completedAt,
      summary,
      failedRates: summary === null ? 1 : 0,
    });
  } finally {
    await acquisition.release();
  }
}

/**
 * The production boundary reads its configuration from the deployed schedule
 * and refuses to run when that schedule does not satisfy the contract. The
 * assertion is intentionally re-evaluated here, not only in CI, so a
 * misconfigured deployment fails loudly instead of capturing at a cadence the
 * freshness rule cannot support.
 */
const DEFAULT_DEPENDENCIES: RateCaptureRunDependencies = Object.freeze({
  capture: (options) => snapshotReviewedLiveRates(undefined, {
    lineage: options.lineage,
    shouldContinue: options.shouldContinue,
    now: options.now,
  }),
  lock: POSTGRES_ADVISORY_CAPTURE_LOCK,
  lineage: PRISMA_CAPTURE_RUN_REPOSITORY,
  scheduler: () => resolveSelectedRateCaptureScheduler(),
  auditSchedule: () => {
    try {
      return assertDeployedCaptureScheduleIsSafe();
    } catch {
      return auditDeployedCaptureSchedule();
    }
  },
  configurationFingerprint: () => fingerprintReviewedRateConfiguration(),
  now: () => new Date(),
}) satisfies RateCaptureRunDependencies;

async function acquire(lock: CaptureLockPort): Promise<CaptureLockAcquisition> {
  try {
    return await lock.acquire();
  } catch {
    return Object.freeze({ acquired: false, reason: "LOCK_UNAVAILABLE" });
  }
}

function captureOutcome(summary: SafeLiveRateRunSummary | null): CaptureRunOutcome {
  if (summary === null) return "failed";
  if (summary.failed > 0 && summary.succeeded === 0) return "failed";
  if (summary.failed > 0 || summary.skipped > 0) return "partial";
  return "succeeded";
}

function sanitizeFailureCodes(summary: SafeLiveRateRunSummary | null): string[] {
  if (summary === null) return ["LIVE_RATE_PREPARATION_FAILURE"];
  return summary.failures.map(({ phase, code }) => `${phase}:${code}`);
}

type ResultInput = Readonly<{
  ok: boolean;
  state: RateCaptureRunState;
  scheduler: RateCaptureSchedulerSelection;
  configurationFingerprint: string;
  startedAt: Date;
  completedAt: Date;
  runId?: string | null;
  scheduledIntervalMs?: number | null;
  lineageRecorded?: boolean;
  errorCode?: string | null;
  summary?: SafeLiveRateRunSummary | null;
  /**
   * Truthful count of sources that could not even be attempted. It is a report
   * about the run, never a fabricated observation.
   */
  failedRates?: number;
}>;

function result(input: ResultInput): RateCaptureRunResult {
  const summary = input.summary ?? null;
  return Object.freeze({
    ok: input.ok,
    state: input.state,
    scheduler: input.scheduler,
    contractVersion: RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
    runId: input.runId ?? null,
    configurationFingerprint: input.configurationFingerprint,
    scheduledIntervalMs: input.scheduledIntervalMs ?? null,
    lineageRecorded: input.lineageRecorded ?? false,
    errorCode: input.errorCode ?? null,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    rates: Object.freeze({
      attempted: summary?.totalAttempted ?? 0,
      succeeded: summary?.succeeded ?? 0,
      failed: summary === null ? (input.failedRates ?? 0) : summary.failed,
      skipped: summary?.skipped ?? 0,
      failures: Object.freeze((summary?.failures ?? []).map((failure) => Object.freeze({
        anchorSlug: failure.anchorSlug,
        corridorSlug: failure.corridorSlug,
        phase: failure.phase,
        code: failure.code,
      }))),
      skippedSources: Object.freeze((summary?.skippedSources ?? []).map((skippedSource) =>
        Object.freeze({ ...skippedSource }))),
    }),
  });
}
