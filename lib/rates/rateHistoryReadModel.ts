import { computeFreshMedian } from "@/lib/rates/median";
import { selectLatestPerAnchor } from "@/lib/rates/latestRateReadModel";
import { PRISMA_RATE_HISTORY_REPOSITORY } from "@/lib/rates/rateHistoryRepository";
import type {
  CorridorRateHistoryPoint,
  CorridorRateHistoryReadResult,
  RateHistoryObservation,
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";

const DEFAULT_WINDOW_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;
const SLICE_WINDOW_MS = 60_000;

export async function readCorridorRateHistory(
  corridorSlug: string,
  options: Readonly<{
    repository?: RateHistoryRepository;
    evaluatedAt?: Date;
    days?: number;
  }> = {},
): Promise<CorridorRateHistoryReadResult> {
  const evaluatedAt = options.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return failure(corridorSlug, "INVALID_EVALUATION_TIME");
  }

  const days = options.days ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return failure(corridorSlug, "INVALID_WINDOW");
  }

  try {
    const repository = options.repository ?? PRISMA_RATE_HISTORY_REPOSITORY;
    const corridor = await repository.findCorridorBySlug(corridorSlug);
    if (!corridor) return failure(corridorSlug, "CORRIDOR_NOT_FOUND");

    const fromDate = new Date(evaluatedAt.getTime() - days * MILLISECONDS_PER_DAY);
    const rawObservations = await repository.findHistoryObservations(
      corridor.id,
      fromDate,
      evaluatedAt,
    );

    const slices = groupObservationsIntoSlices(rawObservations, SLICE_WINDOW_MS);
    const points: CorridorRateHistoryPoint[] = [];

    for (const slice of slices) {
      const selected = selectLatestPerAnchor(slice);
      if (selected.length === 0) continue;

      const latestTime = Math.max(
        ...selected.map((obs) => timestampValue(obs.capturedAt)),
      );
      const pointEvaluatedAt = Number.isFinite(latestTime)
        ? new Date(latestTime)
        : evaluatedAt;

      const medianResult = computeFreshMedian(
        selected.map((obs) => ({
          anchorSlug: obs.anchorSlug,
          corridorSlug: corridor.slug,
          rate: obs.rate,
          capturedAt: obs.capturedAt,
        })),
        pointEvaluatedAt,
      );

      const observations: RateHistoryObservation[] = selected.map((obs) =>
        Object.freeze({
          anchorSlug: obs.anchorSlug,
          anchorName: obs.anchorName,
          rate: obs.rate,
          sourceAmount: obs.sourceAmount,
          destinationAmount: obs.destinationAmount,
          fee: obs.fee,
          capturedAt: formatTimestamp(obs.capturedAt),
        }),
      );

      points.push(
        Object.freeze({
          timestamp: pointEvaluatedAt.toISOString(),
          medianRate: medianResult.median,
          state: medianResult.state,
          sourceCount: selected.length,
          freshSourceCount: medianResult.freshSourceCount,
          observations: Object.freeze(observations),
        }),
      );
    }

    return Object.freeze({
      ok: true,
      corridor: Object.freeze({
        slug: corridor.slug,
        sourceAsset: corridor.assetCodeFrom,
        sourceCountry: corridor.countryFrom,
        destinationAsset: corridor.assetCodeTo,
        destinationCountry: corridor.countryTo,
      }),
      evaluatedAt: evaluatedAt.toISOString(),
      windowDays: days,
      points: Object.freeze(points),
    });
  } catch {
    return failure(corridorSlug, "READ_FAILURE");
  }
}

export function groupObservationsIntoSlices(
  history: readonly RateHistoryRepositoryObservation[],
  windowMs = SLICE_WINDOW_MS,
): readonly (readonly RateHistoryRepositoryObservation[])[] {
  const slices: RateHistoryRepositoryObservation[][] = [];
  let currentSlice: RateHistoryRepositoryObservation[] = [];
  let currentSliceStart = -1;

  for (const obs of history) {
    const time = timestampValue(obs.capturedAt);
    if (!Number.isFinite(time)) continue;

    if (currentSlice.length === 0) {
      currentSlice = [obs];
      currentSliceStart = time;
    } else if (time - currentSliceStart <= windowMs) {
      currentSlice.push(obs);
    } else {
      slices.push(currentSlice);
      currentSlice = [obs];
      currentSliceStart = time;
    }
  }

  if (currentSlice.length > 0) {
    slices.push(currentSlice);
  }

  return Object.freeze(slices.map((slice) => Object.freeze(slice)));
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
  code: "CORRIDOR_NOT_FOUND" | "INVALID_EVALUATION_TIME" | "INVALID_WINDOW" | "READ_FAILURE",
): CorridorRateHistoryReadResult {
  return Object.freeze({ ok: false, corridorSlug, code });
}
