import { readCorridorRateHistory } from "@/lib/rates/rateHistoryReadModel";
import type {
  CorridorRateHistory,
  CorridorRateHistoryReadResult,
} from "@/types/rateHistory";
import type {
  PublicRateHistoryObservation,
  PublicRateHistoryPoint,
  PublicRateHistoryResponse,
  RateHistoryApiErrorCode,
  RateHistoryApiResult,
} from "@/types/api/rateHistory";

const MAX_CORRIDOR_SLUG_LENGTH = 100;
const CORRIDOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

export type RateHistoryApiDependencies = Readonly<{
  readHistory?: (
    corridorSlug: string,
    options: Readonly<{ evaluatedAt: Date; days: number }>,
  ) => Promise<CorridorRateHistoryReadResult>;
  now?: () => Date;
}>;

export async function getRateHistoryApiResult(
  corridorParameter: string | null,
  daysParameter: string | null = null,
  dependencies: RateHistoryApiDependencies = {},
): Promise<RateHistoryApiResult> {
  const corridorValidation = validateCorridorParameter(corridorParameter);
  if (!corridorValidation.ok) return corridorValidation.result;

  const daysValidation = validateDaysParameter(daysParameter);
  if (!daysValidation.ok) return daysValidation.result;

  const evaluatedAt = dependencies.now?.() ?? new Date();
  const read = dependencies.readHistory ?? readCorridorRateHistory;
  let result: CorridorRateHistoryReadResult;

  try {
    result = await read(corridorValidation.corridorSlug, {
      evaluatedAt,
      days: daysValidation.days,
    });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rate history.");
  }

  if (!result.ok) {
    if (result.code === "CORRIDOR_NOT_FOUND") {
      return errorResult(404, "corridor_not_found", "Corridor not found.");
    }
    if (result.code === "INVALID_WINDOW") {
      return errorResult(
        400,
        "invalid_days",
        `The days parameter must be an integer between ${MIN_DAYS} and ${MAX_DAYS}.`,
      );
    }
    return errorResult(500, "internal_error", "Unable to read rate history.");
  }

  try {
    return Object.freeze({ status: 200, body: serializeRateHistory(result) });
  } catch {
    return errorResult(500, "internal_error", "Unable to read rate history.");
  }
}

export function serializeRateHistory(
  result: CorridorRateHistory,
): PublicRateHistoryResponse {
  const points = Object.freeze(
    result.points.map((point) => {
      const observations = Object.freeze(
        point.observations.map(
          (obs) =>
            Object.freeze({
              anchor: Object.freeze({
                slug: obs.anchorSlug,
                name: obs.anchorName,
              }),
              rate: obs.rate,
              sourceAmount: obs.sourceAmount,
              destinationAmount: obs.destinationAmount,
              fee: obs.fee,
              capturedAt: obs.capturedAt,
            }) satisfies PublicRateHistoryObservation,
        ),
      );

      return Object.freeze({
        timestamp: point.timestamp,
        medianRate: point.medianRate,
        state: point.state,
        sourceCount: point.sourceCount,
        freshSourceCount: point.freshSourceCount,
        observations,
      }) satisfies PublicRateHistoryPoint;
    }),
  );

  return Object.freeze({
    corridor: Object.freeze({
      slug: result.corridor.slug,
      sourceAsset: result.corridor.sourceAsset,
      sourceCountry: result.corridor.sourceCountry,
      destinationAsset: result.corridor.destinationAsset,
      destinationCountry: result.corridor.destinationCountry,
    }),
    evaluatedAt: result.evaluatedAt,
    windowDays: result.windowDays,
    points,
  });
}

function validateCorridorParameter(
  value: string | null,
):
  | Readonly<{ ok: true; corridorSlug: string }>
  | Readonly<{ ok: false; result: RateHistoryApiResult }> {
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

function validateDaysParameter(
  value: string | null,
):
  | Readonly<{ ok: true; days: number }>
  | Readonly<{ ok: false; result: RateHistoryApiResult }> {
  if (value === null || value === "") {
    return Object.freeze({ ok: true, days: DEFAULT_DAYS });
  }

  if (!/^\d+$/.test(value)) {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "invalid_days",
        `The days parameter must be an integer between ${MIN_DAYS} and ${MAX_DAYS}.`,
      ),
    });
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "invalid_days",
        `The days parameter must be an integer between ${MIN_DAYS} and ${MAX_DAYS}.`,
      ),
    });
  }

  return Object.freeze({ ok: true, days: parsed });
}

function errorResult(
  status: 400 | 404 | 500,
  code: RateHistoryApiErrorCode,
  message: string,
): RateHistoryApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}
