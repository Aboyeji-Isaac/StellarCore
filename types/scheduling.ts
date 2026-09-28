/**
 * Types for the versioned rate-capture scheduling contract.
 *
 * The contract exists to prove, from repository-owned values, that the cadence
 * of reviewed rate capture stays inside the shared freshness window. It is a
 * statement about StellarCore's capture process only: it is not anchor
 * reachability, quote availability, transfer success, or rate evidence.
 */

export type RateCaptureScheduler = "vercel-cron" | "external";

/**
 * The scheduler the deployment claims is driving capture. `disabled` is an
 * explicit, announced state: no scheduler is approved, so the capture boundary
 * refuses to run rather than silently capturing at an unapproved cadence.
 */
export type RateCaptureSchedulerSelection = RateCaptureScheduler | "disabled";

export type RateCaptureScheduleContract = Readonly<{
  /** Version of the meaning of these values, not of any single number. */
  version: number;
  /** Shared read-time freshness rule this contract must fit inside. */
  freshnessThresholdMs: number;
  /** Hard bound on work performed by one capture invocation. */
  executionBudgetMs: number;
  /** Allowance for scheduler jitter, dispatch latency, and clock skew. */
  jitterAllowanceMs: number;
  /** Documented safety margin: execution budget plus jitter allowance. */
  executionHeadroomMs: number;
  /** Largest capture interval that still satisfies the contract. Derived. */
  maxIntervalMs: number;
}>;

export type CaptureScheduleIssueCode =
  | "CONTRACT_INCONSISTENT"
  | "CAPTURE_SCHEDULER_DISABLED"
  | "CAPTURE_CRON_UNEXPECTED"
  | "CAPTURE_CRON_MISSING"
  | "CAPTURE_CRON_AMBIGUOUS"
  | "REPUTATION_CRON_MISSING"
  | "UNSUPPORTED_CRON_EXPRESSION"
  | "CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET"
  | "SCHEDULER_MANIFEST_MISSING"
  | "SCHEDULER_MANIFEST_MISMATCH";

export type CaptureScheduleIssue = Readonly<{
  code: CaptureScheduleIssueCode;
  severity: "error" | "warning";
  /** Safe, human-readable explanation. Never contains credentials. */
  detail: string;
}>;

export type CaptureScheduleAudit = Readonly<{
  ok: boolean;
  contract: RateCaptureScheduleContract;
  selectedScheduler: RateCaptureSchedulerSelection;
  /** Interval the deployment actually asks for, when it could be derived. */
  intervalMs: number | null;
  issues: readonly CaptureScheduleIssue[];
}>;

export type CaptureSchedulerManifest = Readonly<{
  provider: RateCaptureScheduler;
  route: string;
  /** Capture is never enabled without a recorded maintainer approval. */
  approvalRequired: boolean;
  /** `vercel-cron` only: the schedule the deployment config must contain. */
  cronSchedule?: string;
  /** `vercel-cron` only: plan the schedule requires. */
  requiredPlan?: string;
  /** `vercel-cron` only: the fragment to merge into `vercel.json` crons[]. */
  vercelCron?: Readonly<{ path: string; schedule: string }>;
  /** `external` only: interval the external scheduler is configured with. */
  intervalSeconds?: number;
  /** `external` only: how the external scheduler dispatches the route. */
  dispatch?: Readonly<{
    method: "GET";
    authorization: "bearer_cron_secret";
  }>;
}>;

export type CaptureScheduleDeploymentInput = Readonly<{
  selectedScheduler: RateCaptureSchedulerSelection;
  vercelCrons: readonly Readonly<{ path: string; schedule: string }>[];
  manifests: readonly CaptureSchedulerManifest[];
}>;

/**
 * Who produced a capture run. `manual` is the opt-in operator CLI, which has no
 * scheduler cadence and therefore records no planned interval.
 */
export type CaptureRunScheduler = RateCaptureScheduler | "manual";

export type CaptureRunOutcome = "succeeded" | "partial" | "failed" | "skipped";

/**
 * Durable identity and lineage for one capture invocation. Created before any
 * source work so an invocation that dies mid-run is still traceable.
 */
export type CaptureRunIdentity = Readonly<{
  runId: string;
  contractVersion: number;
  configurationFingerprint: string;
  scheduler: CaptureRunScheduler;
  /** Null for manual operator runs, which have no scheduler cadence. */
  scheduledIntervalMs: number | null;
  scheduledAt: Date;
  startedAt: Date;
}>;

export type CaptureRunCompletion = Readonly<{
  runId: string;
  outcome: CaptureRunOutcome;
  completedAt: Date;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Sanitized codes only. Never raw errors, URLs, or provider payloads. */
  failureCodes: readonly string[];
}>;

export type LatestScheduledCaptureRun = Readonly<{
  runId: string;
  completedAt: Date;
  scheduledIntervalMs: number | null;
  outcome: CaptureRunOutcome;
}>;

export type CaptureRunLineageRepository = Readonly<{
  startRun: (input: CaptureRunIdentity) => Promise<void>;
  completeRun: (input: CaptureRunCompletion) => Promise<void>;
  /** Latest completed run driven by an approved scheduler, not by the CLI. */
  findLatestCompletedScheduledRun: () => Promise<LatestScheduledCaptureRun | null>;
}>;

export type CaptureLockUnavailableReason = "ALREADY_RUNNING" | "LOCK_UNAVAILABLE";

export type CaptureLockAcquisition =
  | Readonly<{ acquired: true; release: () => Promise<void> }>
  | Readonly<{ acquired: false; reason: CaptureLockUnavailableReason }>;

/**
 * Exclusion port for concurrent capture attempts. The production adapter is a
 * PostgreSQL session advisory lock held on one dedicated connection for the
 * whole run; a run that cannot acquire it must not do source work.
 */
export type CaptureLockPort = Readonly<{
  acquire: () => Promise<CaptureLockAcquisition>;
}>;

export type RateCaptureRunState =
  /** Bounded capture work finished (possibly with partial source failure). */
  | "completed"
  /** Another invocation holds the exclusion lock; this one did no work. */
  | "already_running"
  /** No approved scheduler is selected, so capture refused to run. */
  | "disabled"
  /** Capture could not be attempted at all. */
  | "failed";

export type RateCaptureRunResult = Readonly<{
  ok: boolean;
  state: RateCaptureRunState;
  scheduler: RateCaptureSchedulerSelection;
  contractVersion: number;
  runId: string | null;
  configurationFingerprint: string;
  scheduledIntervalMs: number | null;
  /** Whether durable capture-run lineage was written for this invocation. */
  lineageRecorded: boolean;
  /**
   * Sanitized refusal reason when the invocation could not attempt capture at
   * all, for example an incompatible checked-in schedule. Never a raw error.
   */
  errorCode: string | null;
  startedAt: string;
  completedAt: string;
  rates: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    failures: readonly Readonly<{
      anchorSlug: string;
      corridorSlug: string;
      phase: string;
      code: string;
    }>[];
    skippedSources: readonly Readonly<{
      anchorSlug: string;
      corridorSlug: string;
      reason: string;
    }>[];
  }>;
}>;

/**
 * Health of StellarCore's own capture process. Deliberately named for its
 * subject so it cannot be mistaken for evidence about an anchor.
 */
export type CaptureCadenceState = "healthy" | "delayed" | "missed" | "unknown";

export type CaptureCadenceHealth = Readonly<{
  state: CaptureCadenceState;
  /** Cadence the capture run lineage says was planned. */
  scheduledIntervalMs: number | null;
  lastCompletedRunAt: string | null;
  ageMs: number | null;
  /** Whole intervals the process did not observe. Never an anchor metric. */
  missedIntervals: number | null;
  contractVersion: number;
  signalScope: "stellarcore_capture_process";
  notEvidenceOf: readonly string[];
}>;
