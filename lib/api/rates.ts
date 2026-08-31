import { ANCHOR_REGISTRY } from "@/constants/anchors";
import { CORRIDOR_REGISTRY } from "@/constants/corridors";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
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

  try {
    return Object.freeze({ status: 200, body: serializeRates(result) });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rates.");
  }
}

export function serializeRates(result: LatestCorridorRate): PublicRatesResponse {
  const corridor = CORRIDOR_REGISTRY.find(({ slug }) => slug === result.corridorSlug);
  if (!corridor) throw new Error("Corridor is not in the public registry");

  const observations = Object.freeze(result.observations.map((observation) => {
    const anchor = ANCHOR_REGISTRY.find(({ slug }) => slug === observation.anchorSlug);
    const serialized = Object.freeze({
      anchor: Object.freeze({
        slug: observation.anchorSlug,
        name: anchor?.name ?? observation.anchorSlug,
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

  return Object.freeze({
    corridor: Object.freeze({
      slug: corridor.slug,
      sourceAsset: corridor.assetCodeFrom,
      sourceCountry: corridor.countryFrom,
      destinationAsset: corridor.assetCodeTo,
      destinationCountry: corridor.countryTo,
    }),
    evaluatedAt: result.evaluatedAt,
    state: result.state,
    medianRate: result.median,
    sourceCount: result.totalIndependentSources,
    freshSourceCount: result.freshSourceCount,
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
