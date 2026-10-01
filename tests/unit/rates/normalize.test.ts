import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIndicativeRate,
  RateNormalizationError,
} from "@/lib/rates/normalize";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type { Sep38IndicativePrice, Sep38IndicativePriceRequest } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USDC_ALT_ISSUER = "stellar:USDC:GDQDG3ZAA4WJOCSH75N6CVDCM5NV2F6J63T63K4OVD36CEZEK6W4O7X7" as const;
const USD = "iso4217:USD" as const;
const EUR = "iso4217:EUR" as const;

const CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;

const CAPTURED_AT = new Date("2026-08-27T12:00:00.000Z");

function consistentQuote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1.002500000000000001",
    price: "1.000000000000000001",
    sellAmount: "100.2500000000000001",
    buyAmount: "100.0000000000000000",
    fee: Object.freeze({
      total: "0.2500000000000000",
      asset: USD,
      details: Object.freeze([{ name: "Fee", amount: "0.2500000000000000" }]),
    }),
    ...overrides,
  });
}

function reviewedRequest(overrides: Record<string, unknown> = {}): Sep38IndicativePriceRequest {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    sellAmount: "100.2500000000000001",
    countryCode: "US",
    context: "sep31" as const,
    ...overrides,
  }) as unknown as Sep38IndicativePriceRequest;
}

// ---------------------------------------------------------------------------
// Happy Path & Precision Preservation
// ---------------------------------------------------------------------------

test("normalization explicitly maps SEP-38 fields without losing decimal precision", () => {
  const quote = consistentQuote();
  assert.deepEqual(
    normalizeIndicativeRate({
      anchorSlug: "moneygram",
      corridor: CORRIDOR,
      request: reviewedRequest(),
      quote,
      capturedAt: CAPTURED_AT,
    }),
    {
      anchorSlug: "moneygram",
      corridorSlug: CORRIDOR.slug,
      rate: "1.000000000000000001",
      sourceAmount: "100.2500000000000001",
      destinationAmount: "100.0000000000000000",
      fee: "0.2500000000000000",
      capturedAt: CAPTURED_AT,
    },
  );
});

test("normalization succeeds with reciprocal rate quote (buy = price * sell)", () => {
  const reciprocalQuote: Sep38IndicativePrice = Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "0.18",
    price: "0.17",
    sellAmount: "100",
    buyAmount: "17",
    fee: Object.freeze({ total: "1.00", asset: USD, details: Object.freeze([]) }),
  });
  const result = normalizeIndicativeRate({
    anchorSlug: "zeam",
    corridor: CORRIDOR,
    request: reviewedRequest({ sellAmount: "100" }),
    quote: reciprocalQuote,
    capturedAt: CAPTURED_AT,
  });
  assert.equal(result.rate, "0.17");
  assert.equal(result.sourceAmount, "100");
  assert.equal(result.destinationAmount, "17");
  assert.equal(result.fee, "1.00");
});

test("normalization accepts legitimate decimal rounding within 1 ULP tolerance", () => {
  // 100 / 3 = 33.33333..., rounded to 2 decimals is 33.33.
  // 3.00 * 33.33 = 99.99, difference is 0.01 <= tolerance (0.03).
  const roundedQuote: Sep38IndicativePrice = Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "3.00",
    price: "3.00",
    sellAmount: "100.00",
    buyAmount: "33.33",
    fee: Object.freeze({ total: "0.00", asset: USD, details: Object.freeze([]) }),
  });
  const result = normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    request: reviewedRequest({ sellAmount: "100.00" }),
    quote: roundedQuote,
    capturedAt: CAPTURED_AT,
  });
  assert.equal(result.rate, "3.00");
  assert.equal(result.sourceAmount, "100.00");
  assert.equal(result.destinationAmount, "33.33");
});

// ---------------------------------------------------------------------------
// Exact Asset Identity & Adversarial Rejections
// ---------------------------------------------------------------------------

test("normalization rejects same-code but different-issuer Stellar asset", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({ sellAsset: USDC_ALT_ISSUER }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ASSET_MISMATCH"),
  );
});

test("normalization rejects wrong asset scheme (stellar vs iso4217)", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({ buyAsset: `stellar:USD:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` as const }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ASSET_MISMATCH"),
  );
});

test("normalization rejects different fiat currency", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({ buyAsset: EUR }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ASSET_MISMATCH"),
  );
});

test("normalization rejects mismatched delivery method", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest({ buyDeliveryMethod: "PIX" }),
        quote: consistentQuote({ buyDeliveryMethod: "WIRE" }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ASSET_MISMATCH"),
  );
});

test("normalization rejects mismatched country code", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest({ countryCode: "NG" }), // corridor has US
        quote: consistentQuote(),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ASSET_MISMATCH"),
  );
});

test("normalization rejects unsupported fee asset (not buyAsset)", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({ fee: { total: "1", asset: USDC, details: [] } }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("UNSUPPORTED_FEE_ASSET"),
  );
});

// ---------------------------------------------------------------------------
// Arithmetic Consistency & Adversarial Rejections
// ---------------------------------------------------------------------------

test("normalization rejects mathematically inconsistent price/amount combinations", () => {
  // Inconsistent: sellAmount 100, buyAmount 50, price 1.0 (difference is 50)
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({
          price: "1.00",
          totalPrice: "1.00",
          sellAmount: "100.00",
          buyAmount: "50.00",
          fee: { total: "0.00", asset: USD, details: [] },
        }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ARITHMETIC_INCONSISTENCY"),
  );
});

test("normalization rejects inconsistent total_price vs price and fee", () => {
  // totalPrice is 5.00 while price is 1.00 and fee is 0.00
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({
          price: "1.00",
          totalPrice: "5.00",
          sellAmount: "100.00",
          buyAmount: "100.00",
          fee: { total: "0.00", asset: USD, details: [] },
        }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ARITHMETIC_INCONSISTENCY"),
  );
});

test("normalization rejects quote where fee total does not match fee details sum", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({
          fee: {
            total: "1.00",
            asset: USD,
            details: [{ name: "Fee 1", amount: "0.40" }], // 0.40 != 1.00
          },
        }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ARITHMETIC_INCONSISTENCY"),
  );
});

test("normalization rejects quote where totalPrice is strictly less than price with positive fee", () => {
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote({
          price: "2.00",
          totalPrice: "1.00", // totalPrice cannot be lower than price when positive fee
          sellAmount: "100.00",
          buyAmount: "50.00",
          fee: { total: "1.00", asset: USD, details: [] },
        }),
        capturedAt: CAPTURED_AT,
      }),
    hasCode("ARITHMETIC_INCONSISTENCY"),
  );
});

// ---------------------------------------------------------------------------
// Positivity, Timestamps, and Bounds
// ---------------------------------------------------------------------------

test("normalization enforces positivity, timestamps, and Decimal(38,18) bounds", () => {
  for (const [overrides, code] of [
    [{ price: "0" }, "INVALID_RATE"],
    [{ sellAmount: "0" }, "INVALID_SOURCE_AMOUNT"],
    [{ buyAmount: "0" }, "INVALID_DESTINATION_AMOUNT"],
    [{ fee: { total: "-1", asset: USD, details: [] } }, "INVALID_FEE"],
    [{ price: "123456789012345678901" }, "INVALID_RATE"],
    [{ price: "1.1234567890123456789" }, "INVALID_RATE"],
  ] as const) {
    assert.throws(
      () =>
        normalizeIndicativeRate({
          anchorSlug: "moneygram",
          corridor: CORRIDOR,
          request: reviewedRequest(),
          quote: consistentQuote(overrides),
          capturedAt: CAPTURED_AT,
        }),
      hasCode(code),
    );
  }
  assert.throws(
    () =>
      normalizeIndicativeRate({
        anchorSlug: "moneygram",
        corridor: CORRIDOR,
        request: reviewedRequest(),
        quote: consistentQuote(),
        capturedAt: "invalid",
      }),
    hasCode("INVALID_TIMESTAMP"),
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RateNormalizationError && error.code === code;
}
