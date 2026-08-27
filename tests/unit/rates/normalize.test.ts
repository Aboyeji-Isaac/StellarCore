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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RateNormalizationError && error.code === code;
}
