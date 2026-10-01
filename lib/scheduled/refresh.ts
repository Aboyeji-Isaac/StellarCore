import { randomUUID } from "node:crypto";

import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";
import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunSummary,
} from "@/lib/reputation/run";
import { classifyPermanentScheduledFailure } from "@/lib/scheduled/suppression";
import {
  PRISMA_SUPPRESSION_REPOSITORY,
  type SuppressionRepository,
} from "@/lib/scheduled/suppressionRepository";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type {
  ScheduledRateFailure,
  ScheduledReputationFailure,
  ScheduledRefreshResult,
  ScheduledRefreshState,
} from "@/types/scheduled";

export type ScheduledRefreshDependencies = Readonly<{
  snapshotRates: () => Promise<SafeLiveRateRunSummary>;
  evaluateReputation: (options: Readonly<{ evaluatedAt: Date }>) => Promise<ReputationEvaluationRunSummary>;
  suppressions?: SuppressionRepository;
  now: () => Date;
  newRunId: () => string;
  lock: RefreshLockProvider;
  runs: RefreshRunStore;
  log?: RefreshRunLogger | undefined;
}>;

export type ScheduledRefreshOptions = Readonly<{
  /**
   * Operator-driven recovery. When set, the new attempt links to the prior
   * terminal (FAILED or PARTIALLY_SUCCEEDED) run through resumedFromId and
   * carries forward only phases that already reached SUCCEEDED with readable
   * persisted summaries. Nothing else is replayed from the prior run.
   */
  resumeRunId?: string | null | undefined;
  triggeredBy?: string | undefined;
}>;

type RatesSummary = ScheduledRefreshResult["rates"];
type ReputationSummary = ScheduledRefreshResult["reputation"];

type PhaseExecution<T> = Readonly<{
  state: Extract<RefreshPhaseStateValue, "SUCCEEDED" | "FAILED">;
  result: T;
  failures: readonly SanitizedRefreshFailure[];
  fatalError: unknown | null;
}>;

const DEFAULT_TRIGGERED_BY = "cron";

/**
 * Executes one locked scheduler cycle.
 *
 * Ordering is deliberate: the advisory lock is acquired before any work, an
 * orphaned RUNNING row from a dead process is reclaimed as interrupted, a
 * durable run row is created, and only then do phases run. Rate ingestion
 * precedes reputation evaluation so the evaluation can use observations
 * written in the same run.
 *
 * A phase is only SUCCEEDED when it completed with zero reported failures; a
 * rate preparation failure keeps the existing isolation behavior while the
 * phase is recorded FAILED. Reputation still evaluates persisted evidence when
 * rate ingestion partially or totally fails. A fatal reputation orchestration
 * failure is recorded, the run is terminalized truthfully, and the error is
 * rethrown so the HTTP boundary keeps its safe 500 contract.
 */
export async function runScheduledRefresh(
  dependencies: ScheduledRefreshDependencies = DEFAULT_DEPENDENCIES,
  options: ScheduledRefreshOptions = {},
): Promise<ScheduledRefreshResult> {
  const log = dependencies.log ?? emitRefreshRunLog;
  const triggerStartedAt = dependencies.now();
  const lockOutcome = await dependencies.lock.acquire();

  if (!lockOutcome.acquired) {
    const runId = dependencies.newRunId();
    const activeRunId = await findActiveRunId(dependencies.runs);
    const completedAt = dependencies.now();
    log({ event: "refresh_run_already_running", runId, activeRunId });
    return alreadyRunningResult({ runId, activeRunId, startedAt: triggerStartedAt, completedAt });
  }

  const lease = lockOutcome.lease;
  let runId: string | null = null;
  let completed = false;
  try {
    await reclaimOrphanedRun(dependencies, log);

    const resume = await resolveResumePlan(dependencies, options.resumeRunId ?? null);
    const run = await dependencies.runs.create({
      id: dependencies.newRunId(),
      triggeredBy: options.triggeredBy ?? DEFAULT_TRIGGERED_BY,
      attempt: resume.attempt,
      resumedFromId: resume.resumedFromId,
      startedAt: triggerStartedAt,
      initialPhases: resume.initialPhases,
    });
    runId = run.id;
    log({
      event: "refresh_run_started",
      runId: run.id,
      attempt: run.attempt,
      resumedFromId: run.resumedFromId,
    });

    const ratesPhase = await executeRatesPhase(dependencies, run, resume.carriedRates, log);
    const reputationPhase = await executeReputationPhase(
      dependencies,
      run,
      triggerStartedAt,
      resume.carriedReputation,
      log,
    );

    const terminal = resolveTerminalRunState({
      rates: ratesPhase.state,
      reputation: reputationPhase.state,
    });
    const completedAt = dependencies.now();
    const result = buildResult({
      runId: run.id,
      state: toResultState(terminal),
      ok: terminal === "SUCCEEDED",
      activeRunId: null,
      resumedFromId: run.resumedFromId,
      startedAt: triggerStartedAt,
      completedAt,
      rates: ratesPhase.result,
      reputation: reputationPhase.result,
    });
    await dependencies.runs.complete(run.id, {
      state: terminal,
      completedAt,
      failures: Object.freeze([...ratesPhase.failures, ...reputationPhase.failures]),
      result,
    });
    completed = true;
    log({
      event: "refresh_run_completed",
      runId: run.id,
      state: result.state,
      attempt: run.attempt,
      durationMs: Math.max(0, completedAt.getTime() - triggerStartedAt.getTime()),
    });

    if (reputationPhase.fatalError !== null) {
      throw reputationPhase.fatalError;
    }
    return result;
  } catch (error) {
    if (runId !== null && !completed) {
      await safelyMarkInterrupted(dependencies, runId, log);
    }
    throw error;
  } finally {
    await lease.release();
  }
}

const DEFAULT_DEPENDENCIES: ScheduledRefreshDependencies = Object.freeze({
  snapshotRates: snapshotReviewedLiveRates,
  evaluateReputation: evaluatePersistedAnchorReputations,
  now: () => new Date(),
  newRunId: () => randomUUID(),
  lock: createPostgresRefreshLockProvider(),
  runs: createPrismaRefreshRunStore(),
});

export class RefreshRunNotResumableError extends Error {
  constructor(
    readonly runId: string,
    readonly state: RefreshRunStateValue,
  ) {
    super(`Refresh run ${runId} is in state ${state} and cannot be resumed.`);
    this.name = "RefreshRunNotResumableError";
  }
}

async function findActiveRunId(runs: RefreshRunStore): Promise<string | null> {
  try {
    return (await runs.findActive())?.id ?? null;
  } catch {
    // A ledger read failure must not turn "another run owns the lock" into a
    // different outcome; the already_running result is still truthful.
    return null;
  }
}

async function reclaimOrphanedRun(
  dependencies: ScheduledRefreshDependencies,
  log: RefreshRunLogger,
): Promise<void> {
  const orphan = await dependencies.runs.findActive();
  if (orphan === null) return;
  try {
    await dependencies.runs.markInterrupted(orphan.id, {
      completedAt: dependencies.now(),
      code: "INTERRUPTED_ORPHANED_RUN",
    });
    log({
      event: "refresh_run_interrupted",
      runId: orphan.id,
      state: "FAILED",
      code: "INTERRUPTED_ORPHANED_RUN",
    });
  } catch {
    // Another path already terminalized the row; leave the existing history.
  }
}

async function safelyMarkInterrupted(
  dependencies: ScheduledRefreshDependencies,
  runId: string,
  log: RefreshRunLogger,
): Promise<void> {
  try {
    const summary = await dependencies.snapshotRates();
    await recordPermanentFailures(
      summary,
      dependencies.suppressions ?? PRISMA_SUPPRESSION_REPOSITORY,
      startedAt,
    );
    rates = toScheduledRates(summary);
  } catch {
    // Never mask the original orchestration error with a ledger write failure.
  }
}

type ResumePlan = Readonly<{
  attempt: number;
  resumedFromId: string | null;
  initialPhases: Readonly<Partial<Record<RefreshPhaseName, RefreshPhaseProgress>>> | undefined;
  carriedRates: RatesSummary | null;
  carriedReputation: ReputationSummary | null;
}>;

async function resolveResumePlan(
  dependencies: ScheduledRefreshDependencies,
  resumeRunId: string | null,
): Promise<ResumePlan> {
  if (resumeRunId === null) {
    return {
      attempt: 1,
      resumedFromId: null,
      initialPhases: undefined,
      carriedRates: null,
      carriedReputation: null,
    };
  }

  const prior = await dependencies.runs.get(resumeRunId);
  if (prior === null) throw new RefreshRunNotFoundError(resumeRunId);
  if (prior.state !== "FAILED" && prior.state !== "PARTIALLY_SUCCEEDED") {
    throw new RefreshRunNotResumableError(prior.id, prior.state);
  }

  const initialPhases: Partial<Record<RefreshPhaseName, RefreshPhaseProgress>> = {};
  let carriedRates: RatesSummary | null = null;
  let carriedReputation: ReputationSummary | null = null;

  if (prior.phases.rates.state === "SUCCEEDED") {
    const stored = readStoredRates(prior.phases.rates.summary);
    if (stored !== null) {
      carriedRates = stored;
      initialPhases.rates = prior.phases.rates;
    }
  }
  if (prior.phases.reputation.state === "SUCCEEDED") {
    const stored = readStoredReputation(prior.phases.reputation.summary);
    if (stored !== null) {
      carriedReputation = stored;
      initialPhases.reputation = prior.phases.reputation;
    }
  }

  return {
    attempt: prior.attempt + 1,
    resumedFromId: prior.id,
    initialPhases,
    carriedRates,
    carriedReputation,
  };
}

async function executeRatesPhase(
  dependencies: ScheduledRefreshDependencies,
  run: RefreshRunRecord,
  carried: RatesSummary | null,
  log: RefreshRunLogger,
): Promise<PhaseExecution<RatesSummary>> {
  if (carried !== null) {
    log({ event: "refresh_run_phase", runId: run.id, phase: "rates", phaseState: "SUCCEEDED" });
    return { state: "SUCCEEDED", result: carried, failures: ratesToLedgerFailures(carried), fatalError: null };
  }

  await dependencies.runs.setPhase(run.id, "rates", { state: "RUNNING", startedAt: dependencies.now() });
  try {
    const rates = toScheduledRates(await dependencies.snapshotRates());
    const state = rates.failed === 0 ? "SUCCEEDED" : "FAILED";
    await dependencies.runs.setPhase(run.id, "rates", {
      state,
      completedAt: dependencies.now(),
      summary: rates,
    });
    log({ event: "refresh_run_phase", runId: run.id, phase: "rates", phaseState: state });
    return { state, result: rates, failures: ratesToLedgerFailures(rates), fatalError: null };
  } catch {
    const rates = preparationFailure();
    await dependencies.runs.setPhase(run.id, "rates", {
      state: "FAILED",
      completedAt: dependencies.now(),
      summary: rates,
    });
    log({ event: "refresh_run_phase", runId: run.id, phase: "rates", phaseState: "FAILED" });
    return { state: "FAILED", result: rates, failures: ratesToLedgerFailures(rates), fatalError: null };
  }
}

async function executeReputationPhase(
  dependencies: ScheduledRefreshDependencies,
  run: RefreshRunRecord,
  evaluatedAt: Date,
  carried: ReputationSummary | null,
  log: RefreshRunLogger,
): Promise<PhaseExecution<ReputationSummary>> {
  if (carried !== null) {
    log({ event: "refresh_run_phase", runId: run.id, phase: "reputation", phaseState: "SUCCEEDED" });
    return {
      state: "SUCCEEDED",
      result: carried,
      failures: reputationToLedgerFailures(carried),
      fatalError: null,
    };
  }

  await dependencies.runs.setPhase(run.id, "reputation", {
    state: "RUNNING",
    startedAt: dependencies.now(),
  });
  try {
    const reputation = toScheduledReputation(
      await dependencies.evaluateReputation({ evaluatedAt }),
    );
    const state = reputation.failed === 0 ? "SUCCEEDED" : "FAILED";
    await dependencies.runs.setPhase(run.id, "reputation", {
      state,
      completedAt: dependencies.now(),
      summary: reputation,
    });
    log({ event: "refresh_run_phase", runId: run.id, phase: "reputation", phaseState: state });
    return {
      state,
      result: reputation,
      failures: reputationToLedgerFailures(reputation),
      fatalError: null,
    };
  } catch (error) {
    const reputation = reputationPreparationFailure();
    await dependencies.runs.setPhase(run.id, "reputation", {
      state: "FAILED",
      completedAt: dependencies.now(),
      summary: reputation,
    });
    log({ event: "refresh_run_phase", runId: run.id, phase: "reputation", phaseState: "FAILED" });
    return {
      state: "FAILED",
      result: reputation,
      failures: reputationToLedgerFailures(reputation),
      fatalError: error,
    };
  }
}

function buildResult(input: Readonly<{
  runId: string;
  state: ScheduledRefreshState;
  ok: boolean;
  activeRunId: string | null;
  resumedFromId: string | null;
  startedAt: Date;
  completedAt: Date;
  rates: RatesSummary;
  reputation: ReputationSummary;
}>): ScheduledRefreshResult {
  return Object.freeze({
    ok: input.ok,
    runId: input.runId,
    state: input.state,
    activeRunId: input.activeRunId,
    resumedFromId: input.resumedFromId,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    rates: input.rates,
    reputation: input.reputation,
  });
}

function alreadyRunningResult(input: Readonly<{
  runId: string;
  activeRunId: string | null;
  startedAt: Date;
  completedAt: Date;
}>): ScheduledRefreshResult {
  return buildResult({
    runId: input.runId,
    state: "already_running",
    ok: true,
    activeRunId: input.activeRunId,
    resumedFromId: null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    rates: emptyRates(),
    reputation: emptyReputation(),
  });
}

function toResultState(
  state: Extract<RefreshRunStateValue, "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED">,
): ScheduledRefreshState {
  if (state === "SUCCEEDED") return "succeeded";
  if (state === "PARTIALLY_SUCCEEDED") return "partially_succeeded";
  return "failed";
}

function toScheduledRates(summary: SafeLiveRateRunSummary): RatesSummary {
  return Object.freeze({
    attempted: summary.totalAttempted,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    ...(summary.suppressed && summary.suppressed > 0
      ? { suppressed: summary.suppressed }
      : {}),
    failures: Object.freeze(summary.failures.map((failure) => Object.freeze({ ...failure }))),
  });
}

async function recordPermanentFailures(
  summary: SafeLiveRateRunSummary,
  repository: SuppressionRepository,
  observedAt: Date,
): Promise<void> {
  for (const failure of summary.failures) {
    const reason = classifyPermanentScheduledFailure(failure);
    if (!reason) continue;

    await repository.recordDeterministicFailure({
      anchorSlug: failure.anchorSlug,
      corridorSlug: failure.corridorSlug,
      reason,
      failureCode: failure.code,
      failurePhase: failure.phase,
      observedAt,
    });
  }
}

function preparationFailure(): ScheduledRefreshResult["rates"] {
  const failure: ScheduledRateFailure = Object.freeze({
    phase: "PREPARATION",
    code: "LIVE_RATE_PREPARATION_FAILURE",
  });
  return Object.freeze({
    attempted: 0,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    failures: Object.freeze([failure]),
  });
}

function reputationPreparationFailure(): ReputationSummary {
  const failure: ScheduledReputationFailure = Object.freeze({
    anchorSlug: "orchestration",
    code: "REPUTATION_ORCHESTRATION_FAILURE",
  });
  return Object.freeze({
    attempted: 0,
    succeeded: 0,
    failed: 1,
    failures: Object.freeze([failure]),
  });
}

function emptyRates(): RatesSummary {
  return Object.freeze({ attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: Object.freeze([]) });
}

function emptyReputation(): ReputationSummary {
  return Object.freeze({ attempted: 0, succeeded: 0, failed: 0, failures: Object.freeze([]) });
}

function ratesToLedgerFailures(rates: RatesSummary): readonly SanitizedRefreshFailure[] {
  const failures: SanitizedRefreshFailure[] = [];
  for (const failure of rates.failures) {
    const entry: { phase: string; code: string; anchorSlug?: string; corridorSlug?: string } = {
      phase: "rates",
      code: failure.code,
    };
    if ("anchorSlug" in failure && typeof failure.anchorSlug === "string") {
      entry.anchorSlug = failure.anchorSlug;
    }
    if ("corridorSlug" in failure && typeof failure.corridorSlug === "string") {
      entry.corridorSlug = failure.corridorSlug;
    }
    failures.push(Object.freeze(entry));
  }
  return Object.freeze(failures);
}

function reputationToLedgerFailures(
  reputation: ReputationSummary,
): readonly SanitizedRefreshFailure[] {
  return Object.freeze(reputation.failures.map((failure) => Object.freeze({
    phase: "reputation",
    code: failure.code,
    anchorSlug: failure.anchorSlug,
  })));
}

// ---------------------------------------------------------------------------
// Persisted-summary parsing for resume. Stored summaries are written by this
// module from bounded results, so parsing is defensive but never fabricates:
// an unreadable summary means the phase is re-executed rather than carried.
// ---------------------------------------------------------------------------

function readStoredRates(summary: unknown): RatesSummary | null {
  const raw = asRecord(summary);
  if (raw === null) return null;
  const attempted = readCount(raw.attempted);
  const succeeded = readCount(raw.succeeded);
  const failed = readCount(raw.failed);
  const skipped = readCount(raw.skipped);
  if (attempted === null || succeeded === null || failed === null || skipped === null) return null;
  const failures: ScheduledRateFailure[] = [];
  if (Array.isArray(raw.failures)) {
    for (const entry of raw.failures.slice(0, MAX_REFRESH_FAILURE_ENTRIES)) {
      const failure = readStoredRateFailure(entry);
      if (failure !== null) failures.push(failure);
    }
  }
  return Object.freeze({
    attempted,
    succeeded,
    failed,
    skipped,
    failures: Object.freeze(failures),
  });
}

function readStoredRateFailure(input: unknown): ScheduledRateFailure | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  const code = readString(raw.code);
  if (code === null) return null;
  if (raw.phase === "PREPARATION") {
    return Object.freeze({ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" });
  }
  if (raw.phase !== "QUOTE" && raw.phase !== "NORMALIZATION" && raw.phase !== "PERSISTENCE") {
    return null;
  }
  const anchorSlug = readString(raw.anchorSlug);
  const corridorSlug = readString(raw.corridorSlug);
  if (anchorSlug === null || corridorSlug === null) return null;
  return Object.freeze({ anchorSlug, corridorSlug, phase: raw.phase, code });
}

function readStoredReputation(summary: unknown): ReputationSummary | null {
  const raw = asRecord(summary);
  if (raw === null) return null;
  const attempted = readCount(raw.attempted);
  const succeeded = readCount(raw.succeeded);
  const failed = readCount(raw.failed);
  if (attempted === null || succeeded === null || failed === null) return null;
  const failures: ScheduledReputationFailure[] = [];
  if (Array.isArray(raw.failures)) {
    for (const entry of raw.failures.slice(0, MAX_REFRESH_FAILURE_ENTRIES)) {
      const failure = readStoredReputationFailure(entry);
      if (failure !== null) failures.push(failure);
    }
  }
  return Object.freeze({ attempted, succeeded, failed, failures: Object.freeze(failures) });
}

function readStoredReputationFailure(input: unknown): ScheduledReputationFailure | null {
  const raw = asRecord(input);
  if (raw === null) return null;
  const anchorSlug = readString(raw.anchorSlug);
  const code = readString(raw.code);
  if (anchorSlug === null || code === null) return null;
  return Object.freeze({ anchorSlug, code });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
