import { MIN_FRESH_SOURCES } from "@/constants/rates";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { getReviewedCandidateConfiguration } from "@/lib/rates/reviewedCandidateConfiguration";
import {
  measureResponseBytes,
  responseTooLargeError,
  RESPONSE_BUDGETS,
} from "@/lib/api/responseSizeEnforcer";
import {
  decodeCursor,
  paginate,
  validatePaginationParams,
} from "@/types/pagination";
import type { LatestCorridorRate, LatestCorridorRateReadResult } from "@/types/latestRates";
import type {
  PublicRateObservation,
  PublicRatesResponse,
  RatesApiErrorCode,
  RatesApiResult,
} from "@/types/api/rates";

const MAX_CORRIDOR_SLUG_LENGTH = 100;
const CORRIDOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type RatesApiDependencies = Readonly<{
  readLatestRate?: (
    corridorSlug: string,
    options: Readonly<{ evaluatedAt: Date }>,
  ) => Promise<LatestCorridorRateReadResult>;
  now?: () => Date;
}>;

export async function getRatesApiResult(
  corridorParameter: string | null,
  limit: number | null = null,
  after: string | null = null,
  dependencies: RatesApiDependencies = {},
): Promise<RatesApiResult> {
  const validation = validateCorridorParameter(corridorParameter);
  if (!validation.ok) return validation.result;

  const evaluatedAt = dependencies.now?.() ?? new Date();
  const read = dependencies.readLatestRate ?? readLatestCorridorRate;
  let result: LatestCorridorRateReadResult;

  try {
    result = await read(validation.corridorSlug, { evaluatedAt });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rates.");
  }

  if (!result.ok) {
    if (result.code === "CORRIDOR_NOT_FOUND") {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }
    return errorResult(500, "internal_error", "Unable to read rates.");
  }

  // Paginate observations by anchor slug (map observations to have slug field for pagination)
  const observationsForPagination = result.observations.map((obs) => ({
    ...obs,
    slug: obs.anchorSlug,
  }));

  const pagination = validatePaginationParams(limit, after, 500);
  const decodedCursor = pagination.after ? decodeCursor(pagination.after) : null;

  if (pagination.after && !decodedCursor) {
    return errorResult(400, "invalid_pagination_cursor", "The pagination cursor is invalid.");
  }

  const paginated = paginate(observationsForPagination, {
    limit: pagination.limit,
    after: decodedCursor,
  });

  // Extract just the original observations in paginated order
  const paginatedObservations = paginated.items.map(({ snapshotId, anchorSlug, anchorName, rate, sourceAmount, destinationAmount, fee, capturedAt, freshnessState, ageMs, included, exclusionReason }) => ({
    snapshotId,
    anchorSlug,
    anchorName,
    rate,
    sourceAmount,
    destinationAmount,
    fee,
    capturedAt,
    freshnessState,
    ageMs,
    included,
    ...(exclusionReason ? { exclusionReason } : {}),
  }));

  try {
    const body = serializeRates(
      result,
      paginatedObservations,
      paginated.next,
      pagination.limit,
    );
    const responseBytes = measureResponseBytes(body);

    if (responseBytes > RESPONSE_BUDGETS.rates.maxBytes) {
      return responseTooLargeError();
    }

    return Object.freeze({ status: 200, body });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rates.");
  }
}

export function serializeRates(
  result: LatestCorridorRate,
  paginatedObservations: readonly (typeof result.observations)[number][],
  nextCursor: string | null = null,
  limit: number = 100,
): PublicRatesResponse {
  const observations = Object.freeze(paginatedObservations.map((observation) => {
    const serialized = Object.freeze({
      anchor: Object.freeze({
        slug: observation.anchorSlug,
        name: observation.anchorName,
      }),
      rate: observation.rate,
      sourceAmount: observation.sourceAmount,
      destinationAmount: observation.destinationAmount,
      fee: observation.fee,
      capturedAt: observation.capturedAt,
      freshness: Object.freeze({
        state: observation.freshnessState,
        ageMs: observation.ageMs,
      }),
      eligibleForMedian: observation.included,
      ...(observation.exclusionReason
        ? { exclusionReason: observation.exclusionReason }
        : {}),
    }) satisfies PublicRateObservation;
    return serialized;
  }));
  const reviewedCandidateConfiguration = getReviewedCandidateConfiguration(
    result.corridor.slug,
  );

  return Object.freeze({
    corridor: Object.freeze({
      slug: result.corridor.slug,
      sourceAsset: result.corridor.assetCodeFrom,
      sourceCountry: result.corridor.countryFrom,
      destinationAsset: result.corridor.assetCodeTo,
      destinationCountry: result.corridor.countryTo,
    }),
    evaluatedAt: result.evaluatedAt,
    state: result.state,
    medianRate: result.median,
    sourceCount: result.totalIndependentSources,
    freshSourceCount: result.freshSourceCount,
    reviewedCandidateConfiguration,
    medianRequirement: Object.freeze({
      minimumFreshIndependentSources: MIN_FRESH_SOURCES,
    }),
    observations,
    count: paginatedObservations.length,
    limit,
    ...(nextCursor ? { next: nextCursor } : {}),
  });
}

function validateCorridorParameter(
  value: string | null,
):
  | Readonly<{ ok: true; corridorSlug: string }>
  | Readonly<{ ok: false; result: RatesApiResult }> {
  if (value === null || value === "") {
    return Object.freeze({
      ok: false,
      result: errorResult(400, "missing_corridor", "A corridor slug is required."),
    });
  }

  if (
    value.length > MAX_CORRIDOR_SLUG_LENGTH ||
    !CORRIDOR_SLUG_PATTERN.test(value)
  ) {
    return Object.freeze({
      ok: false,
      result: errorResult(400, "invalid_corridor", "The corridor slug is invalid."),
    });
  }

  return Object.freeze({ ok: true, corridorSlug: value });
}

function errorResult(
  status: 400 | 404 | 500,
  code: RatesApiErrorCode,
  message: string,
): RatesApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}
