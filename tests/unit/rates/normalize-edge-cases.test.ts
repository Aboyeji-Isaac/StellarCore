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

// Decimal(38,18): at most 20 integer digits, 18 fractional digits.
const MAX_INTEGER = "9".repeat(20);
const MAX_SCALE = "0.123456789012345678";
const MAX_BOTH = `${MAX_INTEGER}.${"9".repeat(18)}`;

type Field = "price" | "sellAmount" | "buyAmount" | "fee";
const FIELD_CODES: Readonly<Record<Field, string>> = {
  price: "INVALID_RATE",
  sellAmount: "INVALID_SOURCE_AMOUNT",
  buyAmount: "INVALID_DESTINATION_AMOUNT",
  fee: "INVALID_FEE",
};
const POSITIVE_FIELDS: readonly Field[] = ["price", "sellAmount", "buyAmount"];
const ALL_FIELDS: readonly Field[] = [...POSITIVE_FIELDS, "fee"];

function quote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1",
    price: "1",
    sellAmount: "1",
    buyAmount: "1",
    fee: Object.freeze({ total: "0", asset: USD, details: Object.freeze([]) }),
    ...overrides,
  });
}

function withField(field: Field, value: string): Sep38IndicativePrice {
  return field === "fee"
    ? quote({ fee: { total: value, asset: USD, details: [] } })
    : quote({ [field]: value });
}

function normalize(
  q: Sep38IndicativePrice,
  extra: Partial<Parameters<typeof normalizeIndicativeRate>[0]> = {},
) {
  return normalizeIndicativeRate({
    anchorSlug: "moneygram",
    corridor: CORRIDOR,
    quote: q,
    capturedAt: CAPTURED_AT,
    ...extra,
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RateNormalizationError && error.code === code;
}

function assertRejected(field: Field, value: string): void {
  assert.throws(
    () => normalize(withField(field, value)),
    hasCode(FIELD_CODES[field]),
    `${field}=${JSON.stringify(value)} should be rejected`,
  );
}

test("zero price and amounts are rejected in every textual form", () => {
  for (const field of POSITIVE_FIELDS) {
    for (const zero of ["0", "0.0", "0.000000000000000000"]) assertRejected(field, zero);
  }
});

test("a zero fee is valid and preserved verbatim, unlike zero rate or amounts", () => {
  for (const zero of ["0", "0.00"]) {
    assert.equal(normalize(withField("fee", zero)).fee, zero);
  }
});

test("smallest positive value at full scale is accepted", () => {
  const tiny = "0.000000000000000001";

  const price = normalize(quote({
    totalPrice: tiny,
    price: tiny,
    sellAmount: tiny,
    buyAmount: "1",
    fee: { total: "0", asset: USD, details: [] },
  }));
  assert.equal(price.rate, tiny);

  const buy = normalize(quote({
    totalPrice: "1",
    price: "1",
    sellAmount: tiny,
    buyAmount: tiny,
    fee: { total: "0", asset: USD, details: [] },
  }));
  assert.equal(buy.destinationAmount, tiny);

  const fee = normalize(quote({
    totalPrice: "1.000000000000000001",
    price: "1",
    sellAmount: "1.000000000000000001",
    buyAmount: "1",
    fee: { total: tiny, asset: USD, details: [] },
  }));
  assert.equal(fee.fee, tiny);
});

test("negative values are rejected rather than normalized, including negative zero", () => {
  for (const field of ALL_FIELDS) {
    for (const negative of ["-1", "-0.5", "-0", "-0.000000000000000001", "-99999999999999999999"]) {
      assertRejected(field, negative);
    }
  }
});

test("values at the Decimal(38,18) limits are accepted unchanged", () => {
  for (const value of [MAX_INTEGER, MAX_SCALE, MAX_BOTH]) {
    const price = normalize(quote({
      totalPrice: value,
      price: value,
      sellAmount: value,
      buyAmount: "1",
      fee: { total: "0", asset: USD, details: [] },
    }));
    assert.equal(price.rate, value);
    assert.equal(price.sourceAmount, value);

    const buy = normalize(quote({
      totalPrice: "1",
      price: "1",
      sellAmount: value,
      buyAmount: value,
      fee: { total: "0", asset: USD, details: [] },
    }));
    assert.equal(buy.destinationAmount, value);

    // For any positive fee v, choosing buy=v, price=0.5, sell=v and
    // total_price=1 satisfies both SEP-38 formulas exactly.
    const fee = normalize(quote({
      totalPrice: "1",
      price: "0.5",
      sellAmount: value,
      buyAmount: value,
      fee: { total: value, asset: USD, details: [] },
    }));
    assert.equal(fee.fee, value);
  }
});

test("values beyond the Decimal(38,18) limits are rejected for every field", () => {
  const tooManyIntegerDigits = "1" + "0".repeat(20);
  const tooManyFractionDigits = "0.1234567890123456789";
  for (const field of ALL_FIELDS) {
    assertRejected(field, tooManyIntegerDigits);
    assertRejected(field, tooManyFractionDigits);
    assertRejected(field, `${tooManyIntegerDigits}.5`);
    assertRejected(field, "9".repeat(60));
    assertRejected(field, `1.${"0".repeat(40)}1`);
  }
});

test("malformed numeric strings are rejected for every field", () => {
  const malformed = [
    "",
    " ",
    " 1",
    "1 ",
    "1\n",
    "+1",
    "1e5",
    "1E-3",
    "0x10",
    "1,000",
    "1_000",
    "1.2.3",
    ".5",
    "5.",
    ".",
    "01",
    "00",
    "00.5",
    "NaN",
    "Infinity",
    "-Infinity",
    "abc",
    "1a",
    "１", // fullwidth digit one
    "١", // arabic-indic digit one
    "null",
    "undefined",
  ];
  for (const field of ALL_FIELDS) {
    for (const value of malformed) assertRejected(field, value);
  }
});

test("non-string runtime values from untyped anchor JSON are rejected", () => {
  for (const field of ALL_FIELDS) {
    for (const value of [null, undefined, {}, [], true, 5, 1.5]) {
      assert.throws(
        () => normalize(withField(field, value as unknown as string)),
        hasCode(FIELD_CODES[field]),
        `${field}=${String(value)}`,
      );
    }
  }
});

test("accepted values are returned as the original strings, not reformatted", () => {
  const result = normalize(quote({
    totalPrice: "2.250",
    price: "1.500",
    sellAmount: "1.125",
    buyAmount: "0.5",
    fee: { total: "0.250", asset: USD, details: [] },
  }));
  assert.equal(result.rate, "1.500");
  assert.equal(result.sourceAmount, "1.125");
  assert.equal(result.destinationAmount, "0.5");
  assert.equal(result.fee, "0.250");
});

test("validation order reports rate, then source, destination, fee, fee asset, timestamp", () => {
  const allBad = quote({
    price: "0",
    sellAmount: "-1",
    buyAmount: "abc",
    fee: { total: "-1", asset: USDC, details: [] },
  });
  assert.throws(() => normalize(allBad, { capturedAt: "invalid" }), hasCode("INVALID_RATE"));
  assert.throws(
    () => normalize({ ...allBad, price: "1" }, { capturedAt: "invalid" }),
    hasCode("INVALID_SOURCE_AMOUNT"),
  );
  assert.throws(
    () => normalize({ ...allBad, price: "1", sellAmount: "1" }, { capturedAt: "invalid" }),
    hasCode("INVALID_DESTINATION_AMOUNT"),
  );
  assert.throws(
    () => normalize({ ...allBad, price: "1", sellAmount: "1", buyAmount: "1" }, { capturedAt: "invalid" }),
    hasCode("INVALID_FEE"),
  );
  assert.throws(
    () => normalize(quote({ fee: { total: "1", asset: USDC, details: [] } }), { capturedAt: "invalid" }),
    hasCode("UNSUPPORTED_FEE_ASSET"),
  );
  assert.throws(() => normalize(quote(), { capturedAt: "invalid" }), hasCode("INVALID_TIMESTAMP"));
});

test("asset validation runs before numeric validation", () => {
  assert.throws(
    () => normalize(quote({ buyAsset: "iso4217:NGN", price: "-1" })),
    hasCode("ASSET_MISMATCH"),
  );
});

test("malformed or swapped SEP-38 asset identifiers are reported as ASSET_MISMATCH", () => {
  for (const overrides of [
    { sellAsset: "not-an-asset" },
    { buyAsset: "iso4217:usd" },
    { buyAsset: "iso4217:" },
    { sellAsset: "stellar:USDC" },
    { sellAsset: USD, buyAsset: USDC },
  ] as unknown as Partial<Sep38IndicativePrice>[]) {
    assert.throws(() => normalize(quote(overrides)), hasCode("ASSET_MISMATCH"));
  }
});

test("fee must be denominated in the exact buy asset identifier", () => {
  assert.throws(
    () => normalize(quote({ fee: { total: "1", asset: "iso4217:NGN", details: [] } })),
    hasCode("UNSUPPORTED_FEE_ASSET"),
  );
});

test("anchor and corridor slugs must be lowercase kebab-case, checked before assets", () => {
  for (const anchorSlug of ["", "MoneyGram", "money_gram", "-moneygram", "moneygram-", "money--gram", "money gram"]) {
    assert.throws(() => normalize(quote(), { anchorSlug }), hasCode("INVALID_ANCHOR"), anchorSlug);
  }
  for (const slug of ["", "USDC-US", "usdc_us", "usdc--us", "-usdc"]) {
    assert.throws(
      () => normalize(quote(), { corridor: { ...CORRIDOR, slug } }),
      hasCode("INVALID_CORRIDOR"),
      slug,
    );
  }
  assert.throws(
    () => normalize(quote({ buyAsset: "iso4217:NGN" }), { anchorSlug: "BAD" }),
    hasCode("INVALID_ANCHOR"),
  );
  assert.equal(normalize(quote(), { anchorSlug: "anchor-2" }).anchorSlug, "anchor-2");
});

test("timestamps accept Dates and parseable strings and reject invalid ones", () => {
  const fromString = normalize(quote(), { capturedAt: "2026-08-27T12:00:00.000Z" });
  assert.equal(fromString.capturedAt.getTime(), CAPTURED_AT.getTime());

  for (const capturedAt of ["", "invalid", "2026-13-45T00:00:00Z", new Date("nope")]) {
    assert.throws(
      () => normalize(quote(), { capturedAt }),
      hasCode("INVALID_TIMESTAMP"),
      String(capturedAt),
    );
  }
});

test("the observation is frozen and captures a defensive copy of the input Date", () => {
  const input = new Date(CAPTURED_AT.getTime());
  const result = normalize(quote(), { capturedAt: input });
  assert.equal(Object.isFrozen(result), true);
  assert.notEqual(result.capturedAt, input);
  input.setUTCFullYear(2000);
  assert.equal(result.capturedAt.getTime(), CAPTURED_AT.getTime());
});

test("errors are RateNormalizationError instances whose message is the code", () => {
  try {
    normalize(quote({ price: "-1" }));
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof RateNormalizationError);
    assert.equal(error.name, "RateNormalizationError");
    assert.equal(error.code, "INVALID_RATE");
    assert.equal(error.message, "INVALID_RATE");
  }
});
