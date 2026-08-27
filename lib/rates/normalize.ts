import {
  isZeroDecimal,
  parseDatabaseDecimal,
} from "@/lib/rates/decimal";
import { parseSep38AssetIdentifier } from "@/lib/stellar/sep38";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type { NormalizedRateObservation } from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";

export type RateNormalizationCode =
  | "INVALID_ANCHOR"
  | "INVALID_CORRIDOR"
  | "ASSET_MISMATCH"
  | "INVALID_RATE"
  | "INVALID_SOURCE_AMOUNT"
  | "INVALID_DESTINATION_AMOUNT"
  | "INVALID_FEE"
  | "UNSUPPORTED_FEE_ASSET"
  | "INVALID_TIMESTAMP";

export class RateNormalizationError extends Error {
  constructor(readonly code: RateNormalizationCode) {
    super(code);
    this.name = "RateNormalizationError";
  }
}

export function normalizeIndicativeRate(input: Readonly<{
  anchorSlug: string;
  corridor: CorridorRegistryEntry;
  quote: Sep38IndicativePrice;
  capturedAt: Date | string;
}>): NormalizedRateObservation {
  if (!isStableSlug(input.anchorSlug)) fail("INVALID_ANCHOR");
  if (!isStableSlug(input.corridor.slug)) fail("INVALID_CORRIDOR");

  let sellCode: string | undefined;
  let buyCode: string | undefined;
  try {
    sellCode = parseSep38AssetIdentifier(input.quote.sellAsset).code;
    buyCode = parseSep38AssetIdentifier(input.quote.buyAsset).code;
  } catch {
    fail("ASSET_MISMATCH");
  }
  if (
    sellCode !== input.corridor.assetCodeFrom ||
    buyCode !== input.corridor.assetCodeTo
  ) fail("ASSET_MISMATCH");

  const rate = requireDecimal(input.quote.price, true, "INVALID_RATE");
  const sourceAmount = requireDecimal(
    input.quote.sellAmount,
    true,
    "INVALID_SOURCE_AMOUNT",
  );
  const destinationAmount = requireDecimal(
    input.quote.buyAmount,
    true,
    "INVALID_DESTINATION_AMOUNT",
  );
  const fee = requireDecimal(input.quote.fee.total, false, "INVALID_FEE");
  if (input.quote.fee.asset !== input.quote.buyAsset) {
    fail("UNSUPPORTED_FEE_ASSET");
  }

  const capturedAt = input.capturedAt instanceof Date
    ? new Date(input.capturedAt.getTime())
    : new Date(input.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) fail("INVALID_TIMESTAMP");

  return Object.freeze({
    anchorSlug: input.anchorSlug,
    corridorSlug: input.corridor.slug,
    rate,
    sourceAmount,
    destinationAmount,
    fee,
    capturedAt,
  });
}

function requireDecimal(
  value: string,
  positive: boolean,
  code: RateNormalizationCode,
): string {
  try {
    const decimal = parseDatabaseDecimal(value);
    if (positive && isZeroDecimal(decimal)) fail(code);
    return value;
  } catch (error) {
    if (error instanceof RateNormalizationError) throw error;
    fail(code);
  }
}

function isStableSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function fail(code: RateNormalizationCode): never {
  throw new RateNormalizationError(code);
}
