import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIndicativeRate,
  RateNormalizationError,
} from "@/lib/rates/normalize";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type { Sep38IndicativePrice } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USD = "iso4217:USD" as const;
const CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;
const CAPTURED_AT = new Date("2026-08-27T12:00:00.000Z");

function quote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1.01",
    price: "1.000000000000000001",
    sellAmount: "100.000000000000000001",
    buyAmount: "100.0000000000000001",
    fee: Object.freeze({ total: "0.25", asset: USD, details: Object.freeze([]) }),
    ...overrides,
  });
}

test("normalization explicitly maps SEP-38 fields without losing decimal precision", () => {
  assert.deepEqual(normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    quote: quote(),
    capturedAt: CAPTURED_AT,
  }), {
    anchorSlug: "moneygram",
    corridorSlug: CORRIDOR.slug,
    rate: "1.000000000000000001",
    sourceAmount: "100.000000000000000001",
    destinationAmount: "100.0000000000000001",
    fee: "0.25",
    capturedAt: CAPTURED_AT,
  });
});

test("normalization rejects corridor asset mismatch and unsupported fee denomination", () => {
  assert.throws(
    () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote({ buyAsset: "iso4217:NGN" }), capturedAt: CAPTURED_AT }),
    hasCode("ASSET_MISMATCH"),
  );
  assert.throws(
    () => normalizeIndicativeRate({
      anchorSlug: "moneygram",
      corridor: CORRIDOR,
      quote: quote({ fee: { total: "1", asset: USDC, details: [] } }),
      capturedAt: CAPTURED_AT,
    }),
    hasCode("UNSUPPORTED_FEE_ASSET"),
  );
});

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
      () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote(overrides), capturedAt: CAPTURED_AT }),
      hasCode(code),
    );
  }
  assert.throws(
    () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote(), capturedAt: "invalid" }),
    hasCode("INVALID_TIMESTAMP"),
  );
});

test("normalization rejects a negative rate, source amount, or destination amount — not just a negative fee", () => {
  // `requireDecimal`'s `positive` flag only special-cases *zero* (see
  // normalize.ts); a negative value is rejected earlier, unconditionally, by
  // `parseDatabaseDecimal` in lib/rates/decimal.ts, whose `DECIMAL_PATTERN`
  // has no `-` in it at all. That's why a negative *fee* (positive: false)
  // is still rejected below, same as a negative rate/amount (positive: true).
  for (const [overrides, code] of [
    [{ price: "-1" }, "INVALID_RATE"],
    [{ sellAmount: "-1" }, "INVALID_SOURCE_AMOUNT"],
    [{ buyAmount: "-1" }, "INVALID_DESTINATION_AMOUNT"],
    [{ fee: { total: "-0.01", asset: USD, details: [] } }, "INVALID_FEE"],
  ] as const) {
    assert.throws(
      () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote(overrides), capturedAt: CAPTURED_AT }),
      hasCode(code),
    );
  }
});

test("normalization accepts a zero fee — fee is the one amount not required to be positive", () => {
  const result = normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    quote: quote({ fee: { total: "0", asset: USD, details: [] } }),
    capturedAt: CAPTURED_AT,
  });
  assert.equal(result.fee, "0");
});

test("normalization rejects malformed numeric strings rather than silently coercing them", () => {
  const malformed = [
    "abc",
    "",
    "1.2.3",
    "1e10",
    "1E10",
    " 1",
    "1 ",
    "+1",
    "01",
    "00",
    "1.",
    ".1",
    "1,000",
    "Infinity",
    "NaN",
    "-0",
    "0x1",
  ];
  for (const bad of malformed) {
    assert.throws(
      () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote({ price: bad }), capturedAt: CAPTURED_AT }),
      hasCode("INVALID_RATE"),
      `expected price ${JSON.stringify(bad)} to be rejected as INVALID_RATE`,
    );
  }
});

test("a malformed source amount, destination amount, or fee is rejected under its own error code", () => {
  for (const [overrides, code] of [
    [{ sellAmount: "abc" }, "INVALID_SOURCE_AMOUNT"],
    [{ buyAmount: "1,000" }, "INVALID_DESTINATION_AMOUNT"],
    [{ fee: { total: "abc", asset: USD, details: [] } }, "INVALID_FEE"],
  ] as const) {
    assert.throws(
      () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote(overrides), capturedAt: CAPTURED_AT }),
      hasCode(code),
    );
  }
});

test("normalization's Decimal(38,18) integer-digit bound is inclusive at 20 digits, exclusive at 21", () => {
  const twentyDigits = "1".repeat(20);
  const twentyOneDigits = "1".repeat(21);

  const accepted = normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    quote: quote({ price: twentyDigits }),
    capturedAt: CAPTURED_AT,
  });
  assert.equal(accepted.rate, twentyDigits);

  assert.throws(
    () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote({ price: twentyOneDigits }), capturedAt: CAPTURED_AT }),
    hasCode("INVALID_RATE"),
  );
});

test("normalization accepts the full Decimal(38,18) precision at once (20 integer + 18 fraction digits)", () => {
  const atFullPrecision = `${"1".repeat(20)}.${"9".repeat(18)}`;
  const oneMoreFractionDigit = `${"1".repeat(20)}.${"9".repeat(19)}`;

  const accepted = normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    quote: quote({ price: atFullPrecision }),
    capturedAt: CAPTURED_AT,
  });
  assert.equal(accepted.rate, atFullPrecision);

  assert.throws(
    () => normalizeIndicativeRate({ anchorSlug: "moneygram", corridor: CORRIDOR, quote: quote({ price: oneMoreFractionDigit }), capturedAt: CAPTURED_AT }),
    hasCode("INVALID_RATE"),
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RateNormalizationError && error.code === code;
}
