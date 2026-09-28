import { normalizeIndicativeRate, RateNormalizationError } from "@/lib/rates/normalize";
import { persistRateSnapshot } from "@/lib/rates/snapshot";
import type {
  RateCandidate,
  RateEngineFailure,
  RateEngineResult,
  RateEngineSkippedSource,
  RateQuoteProvider,
  RateSnapshotLineage,
  RateSnapshotRepository,
} from "@/types/rates";

export async function runRateEngine(
  candidates: readonly RateCandidate[],
  dependencies: Readonly<{
    quote: RateQuoteProvider;
    repository: RateSnapshotRepository;
    now?: () => Date;
    /**
     * Capture-run lineage for every observation written by this run.
     */
    lineage?: RateSnapshotLineage;
    /**
     * Bounded-execution gate, checked before each reviewed source is attempted.
     * Returning false stops attempting further sources without failing them and
     * without touching observations already persisted.
     */
    shouldContinue?: () => boolean;
  }>,
): Promise<RateEngineResult> {
  const seen = new Set<string>();
  const snapshots: RateEngineResult["snapshots"][number][] = [];
  const failures: RateEngineFailure[] = [];
  const skippedSources: RateEngineSkippedSource[] = [];
  let totalAttempted = 0;

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
    if (dependencies.shouldContinue && !dependencies.shouldContinue()) {
      skippedSources.push(Object.freeze({
        anchorSlug: candidate.anchorSlug,
        corridorSlug: candidate.corridor.slug,
        reason: "EXECUTION_BUDGET_EXHAUSTED",
      }));
      continue;
    }
    totalAttempted += 1;

    let quote;
    try {
      quote = await dependencies.quote(candidate);
    } catch {
      failures.push(engineFailure(candidate, "QUOTE", "QUOTE_FAILURE"));
      continue;
    }

    let observation;
    try {
      observation = normalizeIndicativeRate({
        anchorSlug: candidate.anchorSlug,
        corridor: candidate.corridor,
        quote,
        capturedAt: dependencies.now?.() ?? new Date(),
      });
    } catch (error) {
      failures.push(engineFailure(
        candidate,
        "NORMALIZATION",
        error instanceof RateNormalizationError ? error.code : "NORMALIZATION_FAILURE",
      ));
      continue;
    }

    const persisted = await persistRateSnapshot(
      observation,
      dependencies.repository,
      dependencies.lineage ?? {},
    );
    if (!persisted.ok) {
      failures.push(engineFailure(candidate, "PERSISTENCE", persisted.code));
      continue;
    }
    snapshots.push(persisted.snapshot);
  }

  return Object.freeze({
    totalCandidates: candidates.length,
    totalAttempted,
    succeeded: snapshots.length,
    failed: failures.length,
    skipped: skippedSources.length,
    snapshotsPersisted: snapshots.length,
    snapshots: Object.freeze(snapshots),
    failures: Object.freeze(failures),
    skippedSources: Object.freeze(skippedSources),
  });
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
