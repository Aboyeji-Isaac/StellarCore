import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import type {
  RateCaptureScheduleContract,
  RateCaptureScheduler,
} from "@/types/scheduling";

/**
 * Versioned scheduling contract for reviewed rate capture.
 *
 * Bump the version whenever the meaning of the freshness budget, the bounded
 * execution budget, or deployable-cadence validation changes — not when a
 * number changes. See docs/scheduler-cadence.md.
 */
export const RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION = 1;

/**
 * Hard bound on the work one capture invocation may perform. A capture run
 * stops attempting further reviewed sources once this budget is exhausted,
 * leaving already-persisted observations untouched.
 */
export const RATE_CAPTURE_EXECUTION_BUDGET_MS = 20_000;

/**
 * Allowance for scheduler jitter, dispatch latency, and clock skew between the
 * scheduler and the function. Together with the execution budget this is the
 * documented execution-time safety margin.
 */
export const RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS = 10_000;

/**
 * The documented safety margin. Worst-case age of the newest observation at
 * read time is `interval + executionHeadroomMs`, so the largest interval that
 * can still satisfy the freshness rule is the threshold minus this margin.
 * Both values are derived; no deployment config repeats the arithmetic.
 */
export const RATE_CAPTURE_EXECUTION_HEADROOM_MS =
  RATE_CAPTURE_EXECUTION_BUDGET_MS + RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS;

export const RATE_CAPTURE_MAX_INTERVAL_MS =
  RATE_FRESHNESS_THRESHOLD_MS - RATE_CAPTURE_EXECUTION_HEADROOM_MS;

export const RATE_CAPTURE_SCHEDULE_CONTRACT: RateCaptureScheduleContract =
  Object.freeze({
    version: RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
    freshnessThresholdMs: RATE_FRESHNESS_THRESHOLD_MS,
    executionBudgetMs: RATE_CAPTURE_EXECUTION_BUDGET_MS,
    jitterAllowanceMs: RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
    executionHeadroomMs: RATE_CAPTURE_EXECUTION_HEADROOM_MS,
    maxIntervalMs: RATE_CAPTURE_MAX_INTERVAL_MS,
  });

/** Authenticated orchestration boundaries. Kept distinct on purpose. */
export const RATE_CAPTURE_ROUTE_PATH = "/api/internal/cron/capture-rates";
export const REPUTATION_EVALUATION_ROUTE_PATH = "/api/internal/cron/refresh";
export const CADENCE_HEALTH_ROUTE_PATH = "/api/internal/capture-health";

/**
 * Server-only selection of the approved capture scheduler. Unset means
 * `disabled`: capture refuses to run until a maintainer records a decision.
 */
export const RATE_CAPTURE_SCHEDULER_ENV_VAR = "RATE_CAPTURE_SCHEDULER";

export const RATE_CAPTURE_SCHEDULER_SELECTIONS = [
  "vercel-cron",
  "external",
  "disabled",
] as const;

export const RATE_CAPTURE_SCHEDULERS: readonly RateCaptureScheduler[] =
  Object.freeze(["vercel-cron", "external"]);

/**
 * Note: a faster capture cadence never makes one reviewed source independent
 * or sufficient. `MIN_FRESH_SOURCES` in constants/rates.ts is unchanged and the
 * public median stays null with a single fresh source.
 */
