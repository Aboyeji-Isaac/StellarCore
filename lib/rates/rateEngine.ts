import {
  RATE_CAPTURE_CONCURRENCY,
  RATE_CAPTURE_PER_SOURCE_TIMEOUT_MS,
  RATE_CAPTURE_RUN_DEADLINE_MS,
} from "@/constants/rates";
import {
  runWithBudget,
  type BudgetOptions,
  type BudgetOutcome,
} from "@/lib/rates/captureBudget";
import { normalizeIndicativeRate, RateNormalizationError } from "@/lib/rates/normalize";
import { persistRateSnapshot } from "@/lib/rates/snapshot";
import type {
  RateCandidate,
  RateEngineFailure,
  RateEngineResult,
  RateEngineSkippedSource,
  RateQuoteProvider,
  RateSnapshotRepository,
} from "@/types/rates";

type Observation = ReturnType<typeof normalizeIndicativeRate>;
type CaptureResult =
  | Readonly<{ ok: true; observation: Observation }>
  | Readonly<{ ok: false; failure: RateEngineFailure }>;

type EngineDependencies = Readonly<{
  quote: RateQuoteProvider;
  repository: RateSnapshotRepository;
  now?: () => Date;
  budget?: Partial<BudgetOptions>;
}>;

/**
 * Captures reviewed sources under an explicit execution budget: bounded
 * concurrency, a per-source deadline and a run-level deadline. Only the network
 * capture (quote + normalization) runs under the budget. Persistence happens
 * afterwards, sequentially, and only for sources that completed, so a source
 * that timed out or was cancelled can never create a snapshot.
 *
 * SOURCE_TIMEOUT, RUN_DEADLINE_EXCEEDED and NOT_STARTED describe StellarCore's
 * capture attempt only. They are not evidence that an anchor is down.
 */
export async function runRateEngine(
  candidates: readonly RateCandidate[],
  dependencies: EngineDependencies,
): Promise<RateEngineResult> {
  const seen = new Set<string>();
  const unique: RateCandidate[] = [];
  const skippedSources: RateEngineSkippedSource[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.anchorSlug}\0${candidate.corridor.slug}`;
    if (seen.has(key)) {
      skippedSources.push(Object.freeze({
        anchorSlug: candidate.anchorSlug,
        corridorSlug: candidate.corridor.slug,
        reason: "DUPLICATE_CANDIDATE",
      }));
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  const budget: BudgetOptions = {
    concurrency: dependencies.budget?.concurrency ?? RATE_CAPTURE_CONCURRENCY,
    perSourceMs: dependencies.budget?.perSourceMs ?? RATE_CAPTURE_PER_SOURCE_TIMEOUT_MS,
    runMs: dependencies.budget?.runMs ?? RATE_CAPTURE_RUN_DEADLINE_MS,
  };

  const { outcomes } = await runWithBudget(
    unique,
    (candidate, signal) => capture(candidate, signal, dependencies),
    budget,
  );

  const snapshots: RateEngineResult["snapshots"][number][] = [];
  const failures: RateEngineFailure[] = [];

  for (const [index, candidate] of unique.entries()) {
    const outcome = outcomes[index] as BudgetOutcome<CaptureResult>;

    if (outcome.status === "completed") {
      if (!outcome.value.ok) {
        failures.push(outcome.value.failure);
        continue;
      }
      const persisted = await persistRateSnapshot(outcome.value.observation, dependencies.repository);
      if (!persisted.ok) {
        failures.push(engineFailure(candidate, "PERSISTENCE", persisted.code));
        continue;
      }
      snapshots.push(persisted.snapshot);
      continue;
    }

    failures.push(engineFailure(candidate, budgetPhase(outcome), budgetCode(outcome)));
  }

  return Object.freeze({
    totalCandidates: candidates.length,
    totalAttempted: unique.length,
    succeeded: snapshots.length,
    failed: failures.length,
    skipped: skippedSources.length,
    snapshotsPersisted: snapshots.length,
    snapshots: Object.freeze(snapshots),
    failures: Object.freeze(failures),
    skippedSources: Object.freeze(skippedSources),
  });
}

async function capture(
  candidate: RateCandidate,
  signal: AbortSignal,
  dependencies: EngineDependencies,
): Promise<CaptureResult> {
  let quote;
  try {
    quote = await dependencies.quote(candidate, signal);
  } catch {
    return Object.freeze({ ok: false, failure: engineFailure(candidate, "QUOTE", "QUOTE_FAILURE") });
  }

  try {
    return Object.freeze({
      ok: true,
      observation: normalizeIndicativeRate({
        anchorSlug: candidate.anchorSlug,
        corridor: candidate.corridor,
        quote,
        capturedAt: dependencies.now?.() ?? new Date(),
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      failure: engineFailure(
        candidate,
        "NORMALIZATION",
        error instanceof RateNormalizationError ? error.code : "NORMALIZATION_FAILURE",
      ),
    });
  }
}

function budgetPhase(outcome: BudgetOutcome<CaptureResult>): RateEngineFailure["phase"] {
  return outcome.status === "rejected" ? "QUOTE" : "CAPTURE_BUDGET";
}

function budgetCode(outcome: BudgetOutcome<CaptureResult>): string {
  switch (outcome.status) {
    case "source_timeout": return "SOURCE_TIMEOUT";
    case "run_deadline": return "RUN_DEADLINE_EXCEEDED";
    case "not_started": return "NOT_STARTED";
    default: return "QUOTE_FAILURE";
  }
}

function engineFailure(
  candidate: RateCandidate,
  phase: RateEngineFailure["phase"],
  code: string,
): RateEngineFailure {
  return Object.freeze({
    anchorSlug: candidate.anchorSlug,
    corridorSlug: candidate.corridor.slug,
    phase,
    code,
  });
}