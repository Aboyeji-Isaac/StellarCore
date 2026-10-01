import { MIN_FRESH_SOURCES } from "@/constants/rates";
import {
  FILE_STALE_EVIDENCE_STORE,
  restoreStaleEvidence,
  saveLastKnownGoodEvidence,
  type StaleEvidenceStore,
} from "@/lib/api/staleEvidence";
import { isTransientDatabaseFailure } from "@/lib/databaseErrors";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { getReviewedCandidateConfiguration } from "@/lib/rates/reviewedCandidateConfiguration";
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
  staleEvidenceStore?: StaleEvidenceStore;
}>;

export async function getRatesApiResult(
  corridorParameter: string | null,
  dependencies: RatesApiDependencies = {},
): Promise<RatesApiResult> {
  const validation = validateCorridorParameter(corridorParameter);
  if (!validation.ok) return validation.result;

  const evaluatedAt = dependencies.now?.() ?? new Date();
  const store = dependencies.staleEvidenceStore ?? FILE_STALE_EVIDENCE_STORE;
  const snapshotKey = `rates:v1:${validation.corridorSlug}`;
  const read = dependencies.readLatestRate ?? readLatestCorridorRate;
  let result: LatestCorridorRateReadResult;

  try {
    result = await read(validation.corridorSlug, { evaluatedAt });
  } catch (error) {
    if (isTransientDatabaseFailure(error)) {
      const stale = await restoreStaleEvidence(store, snapshotKey, evaluatedAt);
      if (stale) {
        return Object.freeze({
          status: 200,
          body: stale.body as unknown as PublicRatesResponse,
          degraded: stale.metadata,
        });
      }
    }
    return errorResult(500, "internal_error", "Unable to read rates.");
  }

  if (!result.ok) {
    if (result.code === "CORRIDOR_NOT_FOUND") {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }
    if (result.code === "DATABASE_UNAVAILABLE") {
      const stale = await restoreStaleEvidence(store, snapshotKey, evaluatedAt);
      if (stale) {
        return Object.freeze({
          status: 200,
          body: stale.body as unknown as PublicRatesResponse,
          degraded: stale.metadata,
        });
      }
    }
    return errorResult(500, "internal_error", "Unable to read rates.");
  }

  try {
    const body = serializeRates(result);
    const sourceTimes = body.observations
      .map(({ capturedAt }) => capturedAt)
      .filter(isValidTimestamp);
    await saveLastKnownGoodEvidence(store, snapshotKey, body, sourceTimes, evaluatedAt);
    return Object.freeze({ status: 200, body });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rates.");
  }
}

function isValidTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function serializeRates(result: LatestCorridorRate): PublicRatesResponse {
  const observations = Object.freeze(result.observations.map((observation) => {
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
