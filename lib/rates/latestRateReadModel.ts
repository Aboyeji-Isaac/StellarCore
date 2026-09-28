import { getRateFreshness } from "@/lib/rates/freshness";
import { computeFreshMedian } from "@/lib/rates/median";
import { PRISMA_LATEST_RATE_REPOSITORY } from "@/lib/rates/latestRateRepository";
import { selectIndependentAuthorityObservations } from "@/lib/rates/sourceAuthority";
import type {
  LatestCorridorRateReadResult,
  LatestRateRepository,
  LatestRateRepositoryObservation,
  LatestRateSourceObservation,
} from "@/types/latestRates";
import type { MedianSourceResult } from "@/types/rates";

export async function readLatestCorridorRate(
  corridorSlug: string,
  options: Readonly<{
    repository?: LatestRateRepository;
    evaluatedAt?: Date;
  }> = {},
): Promise<LatestCorridorRateReadResult> {
  const evaluatedAt = options.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return failure(corridorSlug, "INVALID_EVALUATION_TIME");
  }

  try {
    const repository = options.repository ?? PRISMA_LATEST_RATE_REPOSITORY;
    const corridor = await repository.findCorridorBySlug(corridorSlug);
    if (!corridor) return failure(corridorSlug, "CORRIDOR_NOT_FOUND");

    const latest = selectLatestPerAnchor(
      await repository.findLatestObservations(corridor.id),
    );
    // At most one deterministic observation per reviewed authority. Correlated
    // observations stay visible as evidence but never add a median input.
    const selection = selectIndependentAuthorityObservations(latest, evaluatedAt);
    const median = computeFreshMedian(
      selection.selected.map((observation) => ({
        anchorSlug: observation.anchorSlug,
        corridorSlug: corridor.slug,
        rate: observation.rate,
        capturedAt: observation.capturedAt,
      })),
      evaluatedAt,
    );

    // computeFreshMedian preserves input order, so the selected observations
    // and median.sources stay aligned by index.
    const medianBySnapshotId = new Map<string, MedianSourceResult>();
    selection.selected.forEach((observation, index) => {
      medianBySnapshotId.set(observation.id, median.sources[index]!);
    });
    const authorityExclusionBySnapshotId = new Map<
      string,
      LatestRateSourceObservation["exclusionReason"]
    >();
    for (const { observation, reason } of selection.exclusions) {
      authorityExclusionBySnapshotId.set(observation.id, reason);
    }

    let freshObservationCount = 0;
    const observations = Object.freeze(latest.map((observation) => {
      const freshness = getRateFreshness(observation.capturedAt, evaluatedAt);
      if (freshness.state === "fresh") freshObservationCount += 1;
      const authorityReason = authorityExclusionBySnapshotId.get(observation.id);
      const medianSource = medianBySnapshotId.get(observation.id);
      const included = medianSource?.included ?? false;
      const exclusionReason = authorityReason ?? medianSource?.exclusionReason;

      return Object.freeze({
        snapshotId: observation.id,
        anchorSlug: observation.anchorSlug,
        anchorName: observation.anchorName,
        authorityId: observation.authorityId,
        authorityConfigurationVersion: observation.authorityConfigurationVersion,
        rate: observation.rate,
        sourceAmount: observation.sourceAmount,
        destinationAmount: observation.destinationAmount,
        fee: observation.fee,
        capturedAt: formatTimestamp(observation.capturedAt),
        freshnessState: freshness.state,
        ageMs: freshness.ageMs,
        included,
        ...(exclusionReason ? { exclusionReason } : {}),
      }) satisfies LatestRateSourceObservation;
    }));

    return Object.freeze({
      ok: true,
      corridor: Object.freeze({
        slug: corridor.slug,
        assetCodeFrom: corridor.assetCodeFrom,
        countryFrom: corridor.countryFrom,
        assetCodeTo: corridor.assetCodeTo,
        countryTo: corridor.countryTo,
      }),
      evaluatedAt: evaluatedAt.toISOString(),
      state: median.state,
      median: median.median,
      totalObservationCount: observations.length,
      freshObservationCount,
      independentAuthorityCount: selection.independentAuthorityCount,
      freshIndependentSourceCount: median.freshSourceCount,
      observations,
      exclusions: Object.freeze(observations.filter(({ included }) => !included)),
    });
  } catch {
    return failure(corridorSlug, "READ_FAILURE");
  }
}

/**
 * Chooses one observation per anchor before freshness is evaluated. Newer
 * capturedAt wins; identical (or mutually invalid) timestamps use the
 * lexicographically greater persisted snapshot id as a stable tie-breaker.
 */
export function selectLatestPerAnchor(
  history: readonly LatestRateRepositoryObservation[],
): readonly LatestRateRepositoryObservation[] {
  const latest = new Map<string, LatestRateRepositoryObservation>();
  for (const observation of history) {
    const current = latest.get(observation.anchorSlug);
    if (!current || compareObservationOrder(observation, current) > 0) {
      latest.set(observation.anchorSlug, observation);
    }
  }
  return Object.freeze([...latest.values()].sort((left, right) =>
    left.anchorSlug.localeCompare(right.anchorSlug)));
}

function compareObservationOrder(
  left: LatestRateRepositoryObservation,
  right: LatestRateRepositoryObservation,
): number {
  const leftTime = timestampValue(left.capturedAt);
  const rightTime = timestampValue(right.capturedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;
  return left.id === right.id ? 0 : left.id > right.id ? 1 : -1;
}

function timestampValue(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function formatTimestamp(value: Date | string): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "invalid";
}

function failure(
  corridorSlug: string,
  code: "CORRIDOR_NOT_FOUND" | "INVALID_EVALUATION_TIME" | "READ_FAILURE",
): LatestCorridorRateReadResult {
  return Object.freeze({ ok: false, corridorSlug, code });
}
