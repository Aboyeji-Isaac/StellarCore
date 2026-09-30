import {
  absDecimalDiff,
  addDecimals,
  compareDecimals,
  isZeroDecimal,
  maxDecimal,
  multiplyDecimals,
  oneUlp,
  parseDatabaseDecimal,
  type ExactDecimal,
} from "@/lib/rates/decimal";
import { parseSep38AssetIdentifier } from "@/lib/stellar/sep38";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type { NormalizedRateObservation } from "@/types/rates";
import type {
  Sep38AssetIdentifier,
  Sep38FeeDetail,
  Sep38IndicativePrice,
  Sep38IndicativePriceRequest,
} from "@/types/sep38";

export type RateNormalizationCode =
  | "INVALID_ANCHOR"
  | "INVALID_CORRIDOR"
  | "ASSET_MISMATCH"
  | "INVALID_RATE"
  | "INVALID_SOURCE_AMOUNT"
  | "INVALID_DESTINATION_AMOUNT"
  | "INVALID_FEE"
  | "UNSUPPORTED_FEE_ASSET"
  | "INVALID_TIMESTAMP"
  | "ARITHMETIC_INCONSISTENCY";

export class RateNormalizationError extends Error {
  constructor(readonly code: RateNormalizationCode) {
    super(code);
    this.name = "RateNormalizationError";
  }
}

export type NormalizeIndicativeRateInput = Readonly<{
  anchorSlug: string;
  corridor: CorridorRegistryEntry;
  quote: Sep38IndicativePrice;
  capturedAt: Date | string;
  request?: Sep38IndicativePriceRequest;
  expectedSellAsset?: Sep38AssetIdentifier;
  expectedBuyAsset?: Sep38AssetIdentifier;
}>;

export function normalizeIndicativeRate(
  input: NormalizeIndicativeRateInput,
): NormalizedRateObservation {
  if (!isStableSlug(input.anchorSlug)) fail("INVALID_ANCHOR");
  if (!isStableSlug(input.corridor.slug)) fail("INVALID_CORRIDOR");

  const expectedSell = input.request?.sellAsset ?? input.expectedSellAsset;
  const expectedBuy = input.request?.buyAsset ?? input.expectedBuyAsset;

  // Exact asset identifier matches if expected assets provided
  if (expectedSell && input.quote.sellAsset !== expectedSell) {
    fail("ASSET_MISMATCH");
  }
  if (expectedBuy && input.quote.buyAsset !== expectedBuy) {
    fail("ASSET_MISMATCH");
  }

  // Delivery method and context consistency
  if (
    input.request?.buyDeliveryMethod &&
    input.quote.buyDeliveryMethod &&
    input.quote.buyDeliveryMethod !== input.request.buyDeliveryMethod
  ) {
    fail("ASSET_MISMATCH");
  }
  if (
    input.request?.sellDeliveryMethod &&
    input.quote.sellDeliveryMethod &&
    input.quote.sellDeliveryMethod !== input.request.sellDeliveryMethod
  ) {
    fail("ASSET_MISMATCH");
  }
  if (input.request?.countryCode && input.request.countryCode !== input.corridor.countryTo) {
    fail("ASSET_MISMATCH");
  }

  let sellParsed;
  let buyParsed;
  try {
    sellParsed = parseSep38AssetIdentifier(input.quote.sellAsset);
    buyParsed = parseSep38AssetIdentifier(input.quote.buyAsset);
  } catch {
    fail("ASSET_MISMATCH");
  }

  if (
    sellParsed.code !== input.corridor.assetCodeFrom ||
    buyParsed.code !== input.corridor.assetCodeTo
  ) {
    fail("ASSET_MISMATCH");
  }

  // Parse decimals
  const rateDec = parseAndRequireDecimal(input.quote.price, true, "INVALID_RATE");
  const totalPriceDec = parseAndRequireDecimal(input.quote.totalPrice, true, "INVALID_RATE");
  const sourceAmountDec = parseAndRequireDecimal(
    input.quote.sellAmount,
    true,
    "INVALID_SOURCE_AMOUNT",
  );
  const destinationAmountDec = parseAndRequireDecimal(
    input.quote.buyAmount,
    true,
    "INVALID_DESTINATION_AMOUNT",
  );
  const feeDec = parseAndRequireDecimal(input.quote.fee.total, false, "INVALID_FEE");

  if (input.quote.fee.asset !== input.quote.buyAsset) {
    fail("UNSUPPORTED_FEE_ASSET");
  }

  // Validate arithmetic consistency
  validateArithmeticConsistency({
    rate: rateDec,
    totalPrice: totalPriceDec,
    sourceAmount: sourceAmountDec,
    destinationAmount: destinationAmountDec,
    fee: feeDec,
    feeDetails: input.quote.fee.details,
  });

  const capturedAt = input.capturedAt instanceof Date
    ? new Date(input.capturedAt.getTime())
    : new Date(input.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) fail("INVALID_TIMESTAMP");

  return Object.freeze({
    anchorSlug: input.anchorSlug,
    corridorSlug: input.corridor.slug,
    rate: input.quote.price,
    sourceAmount: input.quote.sellAmount,
    destinationAmount: input.quote.buyAmount,
    fee: input.quote.fee.total,
    capturedAt,
  });
}

function validateArithmeticConsistency(input: Readonly<{
  rate: ExactDecimal;
  totalPrice: ExactDecimal;
  sourceAmount: ExactDecimal;
  destinationAmount: ExactDecimal;
  fee: ExactDecimal;
  feeDetails?: readonly Sep38FeeDetail[];
}>): void {
  const { rate, totalPrice, sourceAmount, destinationAmount, fee, feeDetails } = input;

  // 1. Fee details sum verification
  if (feeDetails && feeDetails.length > 0) {
    let detailsSum = parseDatabaseDecimal("0");
    for (const detail of feeDetails) {
      const detailDec = parseAndRequireDecimal(detail.amount, false, "INVALID_FEE");
      detailsSum = addDecimals(detailsSum, detailDec);
    }
    if (compareDecimals(detailsSum, fee) !== 0) {
      fail("ARITHMETIC_INCONSISTENCY");
    }
  }

  // 2. Fee monotonicity: with fee in buyAsset, totalPrice must be >= rate (conversion costs more)
  // If fee is 0, totalPrice must be consistent with rate within 1 ULP
  if (isZeroDecimal(fee)) {
    const ulpP = oneUlp(rate.scale);
    const ulpT = oneUlp(totalPrice.scale);
    const maxUlp = maxDecimal(ulpP, ulpT);
    if (compareDecimals(absDecimalDiff(totalPrice, rate), maxUlp) > 0) {
      fail("ARITHMETIC_INCONSISTENCY");
    }
  } else {
    // With positive fee, totalPrice must not be less than rate (allowing 1 ULP rounding)
    const ulp = maxDecimal(oneUlp(rate.scale), oneUlp(totalPrice.scale));
    if (compareDecimals(addDecimals(totalPrice, ulp), rate) < 0) {
      fail("ARITHMETIC_INCONSISTENCY");
    }
  }

  // 3. Amount & price consistency
  const S = sourceAmount;
  const B = destinationAmount;
  const P = rate;
  const T = totalPrice;
  const F = fee;

  const ulpB = oneUlp(B.scale);
  const ulpS = oneUlp(S.scale);

  // Representation 1: Standard SEP-38
  // sell_amount = total_price * buy_amount
  // sell_amount = price * (buy_amount + fee)
  const TB = multiplyDecimals(T, B);
  const diffTB = absDecimalDiff(S, TB);
  const tolTB = maxDecimal(multiplyDecimals(T, ulpB), ulpS);

  const B_plus_F = addDecimals(B, F);
  const P_BF = multiplyDecimals(P, B_plus_F);
  const diffPBF = absDecimalDiff(S, P_BF);
  const tolPBF = maxDecimal(multiplyDecimals(P, ulpB), ulpS);

  const rep1Valid =
    compareDecimals(diffTB, tolTB) <= 0 && compareDecimals(diffPBF, tolPBF) <= 0;

  // Representation 2: Reciprocal / direct rate
  // buy_amount = price * sell_amount
  // buy_amount + fee = total_price * sell_amount
  const PS = multiplyDecimals(P, S);
  const diffPS = absDecimalDiff(B, PS);
  const tolPS = maxDecimal(multiplyDecimals(P, ulpS), ulpB);

  const TS = multiplyDecimals(T, S);
  const diffTS = absDecimalDiff(B_plus_F, TS);
  const tolTS = maxDecimal(multiplyDecimals(T, ulpS), ulpB);

  const rep2Valid =
    compareDecimals(diffPS, tolPS) <= 0 && compareDecimals(diffTS, tolTS) <= 0;

  if (!rep1Valid && !rep2Valid) {
    fail("ARITHMETIC_INCONSISTENCY");
  }
}

function parseAndRequireDecimal(
  value: string,
  positive: boolean,
  code: RateNormalizationCode,
): ExactDecimal {
  try {
    const decimal = parseDatabaseDecimal(value);
    if (positive && isZeroDecimal(decimal)) fail(code);
    return decimal;
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
