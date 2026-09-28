import externalCaptureManifest from "@/deploy/scheduler/external.capture.json";
import vercelCronCaptureManifest from "@/deploy/scheduler/vercel-cron.capture.json";
import {
  auditCaptureSchedule,
  assertCaptureScheduleIsDeployable,
  resolveSelectedRateCaptureScheduler,
} from "@/lib/scheduling/captureCadence";
import type {
  CaptureScheduleAudit,
  CaptureSchedulerManifest,
} from "@/types/scheduling";
import vercelConfig from "@/vercel.json";

/**
 * Checked-in scheduler manifests. Capture is never enabled by editing one of
 * these alone: the deployed cadence must also agree with `vercel.json`, and the
 * audit fails when the two disagree.
 */
export const CAPTURE_SCHEDULER_MANIFESTS: readonly CaptureSchedulerManifest[] =
  Object.freeze([
    vercelCronCaptureManifest as CaptureSchedulerManifest,
    externalCaptureManifest as CaptureSchedulerManifest,
  ]);

const DEPLOYED_VERCEL_CRONS: readonly Readonly<{
  path: string;
  schedule: string;
}>[] = Object.freeze(
  (vercelConfig.crons ?? []).map(({ path, schedule }) => Object.freeze({ path, schedule })),
);

/**
 * Audits the cadence this repository would actually deploy. Reads only
 * repository files and the server-only scheduler selection; no database,
 * network, or anchor access.
 */
export function auditDeployedCaptureSchedule(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CaptureScheduleAudit {
  return auditCaptureSchedule({
    selectedScheduler: resolveSelectedRateCaptureScheduler(env),
    vercelCrons: DEPLOYED_VERCEL_CRONS,
    manifests: CAPTURE_SCHEDULER_MANIFESTS,
  });
}

export function assertDeployedCaptureScheduleIsSafe(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CaptureScheduleAudit {
  return assertCaptureScheduleIsDeployable(auditDeployedCaptureSchedule(env));
}
