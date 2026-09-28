import {
  RATE_CAPTURE_ROUTE_PATH,
  RATE_CAPTURE_SCHEDULE_CONTRACT,
  RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
  RATE_CAPTURE_SCHEDULER_ENV_VAR,
  RATE_CAPTURE_SCHEDULER_SELECTIONS,
  REPUTATION_EVALUATION_ROUTE_PATH,
} from "@/constants/scheduling";
import { intervalMsFromCronExpression } from "@/lib/scheduling/cronExpression";
import type {
  CaptureScheduleAudit,
  CaptureScheduleDeploymentInput,
  CaptureScheduleIssue,
  CaptureScheduleIssueCode,
  RateCaptureSchedulerSelection,
} from "@/types/scheduling";

/**
 * Reads the server-only scheduler selection. Anything unrecognised, including
 * an unset variable, resolves to `disabled` rather than to a guess: capture
 * must not run at a cadence nobody approved.
 */
export function resolveSelectedRateCaptureScheduler(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RateCaptureSchedulerSelection {
  const raw = env[RATE_CAPTURE_SCHEDULER_ENV_VAR]?.trim();
  if (!raw) return "disabled";
  return (RATE_CAPTURE_SCHEDULER_SELECTIONS as readonly string[]).includes(raw)
    ? (raw as RateCaptureSchedulerSelection)
    : "disabled";
}

/**
 * Pure deployment-time audit of the configured capture cadence.
 *
 * It fails closed: an unsupported cron expression, a cadence that does not fit
 * inside the freshness threshold plus the documented execution safety margin,
 * a scheduler manifest that disagrees with the deployment config, or two
 * schedulers pointed at the same route are all errors. Enabling capture
 * without an approved scheduler is reported, but as a warning, because a
 * repository that has not yet approved a provider is a valid state.
 */
export function auditCaptureSchedule(
  input: CaptureScheduleDeploymentInput,
): CaptureScheduleAudit {
  const contract = RATE_CAPTURE_SCHEDULE_CONTRACT;
  const issues: CaptureScheduleIssue[] = [];

  if (
    contract.version !== RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION ||
    contract.executionHeadroomMs !==
      contract.executionBudgetMs + contract.jitterAllowanceMs ||
    contract.maxIntervalMs !==
      contract.freshnessThresholdMs - contract.executionHeadroomMs ||
    contract.maxIntervalMs <= 0
  ) {
    issues.push(issue(
      "CONTRACT_INCONSISTENT",
      "error",
      "Scheduling contract values are not internally consistent; the maximum " +
        "interval must be the freshness threshold minus the documented margin.",
    ));
  }

  const captureCrons = input.vercelCrons.filter(
    ({ path }) => path === RATE_CAPTURE_ROUTE_PATH,
  );
  const reputationCrons = input.vercelCrons.filter(
    ({ path }) => path === REPUTATION_EVALUATION_ROUTE_PATH,
  );

  if (reputationCrons.length !== 1) {
    issues.push(issue(
      "REPUTATION_CRON_MISSING",
      "error",
      `Expected exactly one deployment cron entry for the independent ` +
        `reputation-evaluation route ${REPUTATION_EVALUATION_ROUTE_PATH}.`,
    ));
  } else if (intervalMsFromCronExpression(reputationCrons[0]!.schedule) === null) {
    issues.push(issue(
      "UNSUPPORTED_CRON_EXPRESSION",
      "error",
      `The reputation-evaluation schedule "${reputationCrons[0]!.schedule}" ` +
        `could not be bounded by this repository's cron evaluation.`,
    ));
  }

  let intervalMs: number | null = null;

  if (input.selectedScheduler === "disabled") {
    issues.push(issue(
      "CAPTURE_SCHEDULER_DISABLED",
      "warning",
      `No approved capture scheduler is selected (${RATE_CAPTURE_SCHEDULER_ENV_VAR} ` +
        `is unset or invalid). The capture boundary refuses to run until a ` +
        `maintainer records a provider decision in docs/scheduler-cadence.md.`,
    ));
    if (captureCrons.length > 0) {
      issues.push(issue(
        "CAPTURE_CRON_UNEXPECTED",
        "error",
        `Deployment config schedules the capture route while the scheduler is ` +
          `disabled, which would capture at an unapproved cadence.`,
      ));
    }
  } else {
    const manifest = input.manifests.find(
      ({ provider }) => provider === input.selectedScheduler,
    );

    if (!manifest) {
      issues.push(issue(
        "SCHEDULER_MANIFEST_MISSING",
        "error",
        `The selected scheduler "${input.selectedScheduler}" has no checked-in ` +
          `manifest, so its cadence cannot be validated.`,
      ));
    }

    if (input.selectedScheduler === "vercel-cron") {
      intervalMs = auditVercelCronSelection(captureCrons, manifest, contract.maxIntervalMs, issues);
    } else {
      intervalMs = auditExternalSelection(captureCrons, manifest, contract.maxIntervalMs, issues);
    }
  }

  return Object.freeze({
    ok: !issues.some(({ severity }) => severity === "error"),
    contract,
    selectedScheduler: input.selectedScheduler,
    intervalMs,
    issues: Object.freeze(issues),
  });
}

export function assertCaptureScheduleIsDeployable(
  audit: CaptureScheduleAudit,
): CaptureScheduleAudit {
  if (!audit.ok) {
    const codes = audit.issues
      .filter(({ severity }) => severity === "error")
      .map(({ code }) => code)
      .join(", ");
    throw new Error(`Incompatible rate-capture schedule: ${codes}`);
  }
  return audit;
}

function auditVercelCronSelection(
  captureCrons: readonly Readonly<{ path: string; schedule: string }>[],
  manifest: CaptureScheduleDeploymentInput["manifests"][number] | undefined,
  maxIntervalMs: number,
  issues: CaptureScheduleIssue[],
): number | null {
  if (captureCrons.length === 0) {
    issues.push(issue(
      "CAPTURE_CRON_MISSING",
      "error",
      `Scheduler "vercel-cron" is selected but deployment config has no cron ` +
        `entry for ${RATE_CAPTURE_ROUTE_PATH}.`,
    ));
    return null;
  }
  if (captureCrons.length > 1) {
    issues.push(issue(
      "CAPTURE_CRON_AMBIGUOUS",
      "error",
      `Deployment config schedules ${RATE_CAPTURE_ROUTE_PATH} more than once.`,
    ));
    return null;
  }

  const schedule = captureCrons[0]!.schedule;
  if (manifest?.vercelCron && manifest.vercelCron.path !== RATE_CAPTURE_ROUTE_PATH) {
    issues.push(issue(
      "SCHEDULER_MANIFEST_MISMATCH",
      "error",
      `The approved manifest fragment targets a route other than ` +
        `${RATE_CAPTURE_ROUTE_PATH}.`,
    ));
  }
  if (manifest?.cronSchedule !== undefined && manifest.cronSchedule !== schedule) {
    issues.push(issue(
      "SCHEDULER_MANIFEST_MISMATCH",
      "error",
      `The approved manifest requires schedule "${manifest.cronSchedule}" for ` +
        `the capture route but deployment config declares "${schedule}".`,
    ));
  }

  const intervalMs = intervalMsFromCronExpression(schedule);
  if (intervalMs === null) {
    issues.push(issue(
      "UNSUPPORTED_CRON_EXPRESSION",
      "error",
      `The capture schedule "${schedule}" could not be bounded by this ` +
        `repository's cron evaluation, so its freshness safety is unproven.`,
    ));
    return null;
  }

  return assertWithinFreshnessBudget(intervalMs, maxIntervalMs, issues);
}

function auditExternalSelection(
  captureCrons: readonly Readonly<{ path: string; schedule: string }>[],
  manifest: CaptureScheduleDeploymentInput["manifests"][number] | undefined,
  maxIntervalMs: number,
  issues: CaptureScheduleIssue[],
): number | null {
  if (captureCrons.length > 0) {
    issues.push(issue(
      "CAPTURE_CRON_UNEXPECTED",
      "error",
      `Scheduler "external" is selected, so ${RATE_CAPTURE_ROUTE_PATH} must ` +
        `be absent from deployment cron config; two schedulers would overlap.`,
    ));
  }

  if (manifest?.intervalSeconds === undefined) {
    issues.push(issue(
      "SCHEDULER_MANIFEST_MISMATCH",
      "error",
      `The external scheduler manifest must declare an interval in seconds.`,
    ));
    return null;
  }

  if (!Number.isInteger(manifest.intervalSeconds) || manifest.intervalSeconds <= 0) {
    issues.push(issue(
      "SCHEDULER_MANIFEST_MISMATCH",
      "error",
      `The external scheduler interval must be a positive whole number of seconds.`,
    ));
    return null;
  }

  return assertWithinFreshnessBudget(
    manifest.intervalSeconds * 1_000,
    maxIntervalMs,
    issues,
  );
}

function assertWithinFreshnessBudget(
  intervalMs: number,
  maxIntervalMs: number,
  issues: CaptureScheduleIssue[],
): number {
  if (intervalMs > maxIntervalMs) {
    issues.push(issue(
      "CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET",
      "error",
      `A ${intervalMs}ms capture interval, plus the documented execution ` +
        `safety margin, does not fit inside the freshness budget: the largest ` +
        `supported interval is ${maxIntervalMs}ms.`,
    ));
  }
  return intervalMs;
}

function issue(
  code: CaptureScheduleIssueCode,
  severity: CaptureScheduleIssue["severity"],
  detail: string,
): CaptureScheduleIssue {
  return Object.freeze({ code, severity, detail });
}
