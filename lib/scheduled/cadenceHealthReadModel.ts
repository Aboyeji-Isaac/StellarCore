import { auditDeployedCaptureSchedule } from "@/lib/scheduling/deploymentSchedule";
import { evaluateCaptureCadenceHealth } from "@/lib/scheduled/cadenceHealth";
import { PRISMA_CAPTURE_RUN_REPOSITORY } from "@/lib/scheduled/captureRunRepository";
import type {
  CaptureCadenceHealth,
  CaptureRunLineageRepository,
  CaptureScheduleAudit,
} from "@/types/scheduling";

export type CaptureCadenceHealthDependencies = Readonly<{
  lineage: CaptureRunLineageRepository;
  auditSchedule: () => CaptureScheduleAudit;
  now: () => Date;
}>;

/**
 * Reads the last completed *scheduled* capture run and derives cadence health.
 *
 * It reads the capture-run ledger only. It never reads snapshots, never
 * recalculates a median, and never re-labels persisted evidence. When no
 * scheduled run has completed, the answer is `unknown` rather than `healthy`:
 * absence of lineage is not evidence that capture works.
 */
export async function readCaptureCadenceHealth(
  dependencies: CaptureCadenceHealthDependencies = DEFAULT_DEPENDENCIES,
): Promise<CaptureCadenceHealth> {
  const latest = await dependencies.lineage.findLatestCompletedScheduledRun();
  const audit = dependencies.auditSchedule();

  return evaluateCaptureCadenceHealth({
    lastCompletedRunAt: latest?.completedAt ?? null,
    scheduledIntervalMs: latest?.scheduledIntervalMs ?? audit.intervalMs,
    now: dependencies.now(),
  });
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  lineage: PRISMA_CAPTURE_RUN_REPOSITORY,
  auditSchedule: auditDeployedCaptureSchedule,
  now: () => new Date(),
}) satisfies CaptureCadenceHealthDependencies;
