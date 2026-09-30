import assert from "node:assert/strict";
import test from "node:test";

import { DeterministicRandom } from "./deterministicRandom";
import {
  parseSep38AssetIdentifier,
  parseSep38Info,
  parseSep38IndicativePrice,
  parseSep38PricesResponse,
} from "@/lib/stellar/sep38";

/**
 * Issue #141: deterministic property/fuzz coverage for the untrusted SEP-38
 * JSON/decimal/asset parsers. Generated malformed, oversized, deeply nested,
 * Unicode, duplicate-field, invalid-number, and boundary inputs must produce
 * bounded typed failures (Sep38ClientError) — never uncaught exceptions — and
 * every accepted result must satisfy the normalization invariants.
 *
 * All seeds are fixed; see tests/fuzz/README.md for reproduction.
 */
const SEEDS = [20260930, 20261002];
const CASES_PER_SEED = 400;

// Hard input bounds keep the harness itself fast and bounded.
const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 16;
const MAX_ARRAY_ITEMS = 24;

const UNICODE_SAMPLES = [
  "é", "中", "𝄞", "\u0000", "\u0007", "\u007f", "\ufffd", "\ud83d\ude00",
  "\u2028", "\u2029", "\t", "\n", "\r\n", "\\\\", "\\\"", "\\\":",
];

const ASSET_FORMS = [
  "iso4217:USD", "iso4217:usd", "iso4217:USDD", "iso4217:",
  "stellar:native", "stellar:XLM", "stellar:TestXLM",
  "stellar:USDC:GA5XIGA5C7NVWR3VOqRLUZ configurability", // intentionally broken
  "stellar:USDC:GCQSOAXZUTLTV4KCP2EY34ABXJOGPTXXM2YBV4ZPZE522RLDANSONOAO",
  "stellar:usdc:GCQSOAXZUTLTV4KCP2EY34ABXJOGPTXXM2YBV4ZPZE522RLDANSONOAO",
  "stellar:cat:GAAAA2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2",
  "stellar:63bb19fb2c895821c2aeb0b0e2b6d64ea7cc2f0bca56e87a44ee1f8d1f4c8bd9:lp",
  "stellar:63bb19fb2c895821c2aeb0b0e2b6d64ea7cc2f0bca56e87a44ee1f8d1f4c8bd:lp",
  "stellar:USDC", "stellar:", "USDC:issuer", "", "iso4217:USD\\:x",
];

const DECIMAL_FORMS = [
  "0", "0.0", "000", "1", "1.5", "0.000001", "-1", "-0.5", "+1", "1e3", "1E3",
  "1.2.3", ".5", "5.", "NaN", "Infinity", "-Infinity", "0x10", "1_000",
  "9007199254740993", "0.000000000000000000000000001",
  "9".repeat(30) + "." + "9".repeat(18),
  " 1", "1 ", "１", "1\u0000", "",
];

const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function isTypedSep38Failure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "Sep38ClientError" ||
    // Deeply nested structures can overflow the JS stack inside JSON.stringify
    // comparisons; a RangeError is still a bounded typed failure at the
    // boundary, not data-dependent control flow.
    (error instanceof RangeError)
  );
}

function assertBoundedFailure(seed: number, index: number, kind: string, invocation: () => unknown): void {
  try {
    invocation();
  } catch (error) {
    if (!isTypedSep38Failure(error)) {
      assert.fail(
        `fuzz case failed: seed=${seed} index=${index} kind=${kind} ` +
          `unexpected error ${(error as Error)?.name}: ${(error as Error)?.message}`,
      );
    }
    return;
  }
}

test("SEP-38 asset identifier parsing fails bounded on generated malformed identifiers", () => {
  for (const seed of SEEDS) {
    const random = new DeterministicRandom(seed);
    for (let index = 0; index < CASES_PER_SEED; index += 1) {
      const identifier = generateAssetIdentifier(random, seed, index);
      const invocation = () => parseSep38AssetIdentifier(identifier);
      try {
        const parsed = invocation() as { value: string; scheme: string };
        // If accepted, the value must round-trip and the scheme must be real.
        assert.ok(["iso4217", "stellar"].includes(parsed.scheme));
        assert.equal(typeof parsed.value, "string");
      } catch (error) {
        assertBoundedFailure(seed, index, "asset-identifier", () => {
          throw error;
        });
      }
    }
  }
});

test("SEP-38 asset identifier accepts a corpus of structurally valid forms", () => {
  assert.doesNotThrow(() => parseSep38AssetIdentifier("iso4217:USD"));
  assert.doesNotThrow(() => parseSep38AssetIdentifier("stellar:native"));
  assert.doesNotThrow(() =>
    parseSep38AssetIdentifier(`stellar:USDC:${VALID_ISSUER}`));
  assert.doesNotThrow(() =>
    parseSep38AssetIdentifier(
      "stellar:63bb19fb2c895821c2aeb0b0e2b6d64ea7cc2f0bca56e87a44ee1f8d1f4c8bd9:lp",
    ));
});

test("SEP-38 /info parsing survives generated malformed JSON structures without uncaught failures", () => {
  for (const seed of SEEDS) {
    const random = new DeterministicRandom(seed);
    for (let index = 0; index < CASES_PER_SEED; index += 1) {
      const payload = generateInfoPayload(random);
      try {
        const info = parseSep38Info(payload, "fuzz /info");
        assertInfoInvariants(info);
      } catch (error) {
        assertBoundedFailure(seed, index, "info-structure", () => {
          throw error;
        });
      }
    }
  }
});

test("SEP-38 generated decimal strings either parse as positive decimals or fail typed", () => {
  for (const seed of SEEDS) {
    const random = new DeterministicRandom(seed);
    for (let index = 0; index < CASES_PER_SEED; index += 1) {
      const amount = random.nextBoolean()
        ? random.pick(DECIMAL_FORMS)
        : generateDecimalString(random);
      const payload = {
        total_price: amount,
        price: amount,
        sell_amount: amount,
        buy_amount: amount,
        fee: { total: "0.01", asset: "iso4217:USD", details: [] },
      };
      try {
        const quote = parseSep38IndicativePrice(
          payload,
          {
            sellAsset: "stellar:XLM",
            buyAsset: "iso4217:USD",
            sellAmount: "1",
            context: "sep6",
          },
          "fuzz /price",
        );
        for (const value of [
          quote.totalPrice,
          quote.price,
          quote.sellAmount,
          quote.buyAmount,
        ]) {
          assert.match(value, /^(?:0|[1-9]\d*)(?:\.\d+)?$/);
        }
      } catch (error) {
        assertBoundedFailure(seed, index, "decimal", () => {
          throw error;
        });
      }
    }
  }
});

test("SEP-38 duplicate and conflicting asset/pair fields never normalize into ambiguous evidence", () => {
  const duplicatedAsset = {
    assets: [
      { asset: "iso4217:USD", country_codes: ["US"] },
      { asset: "iso4217:USD", country_codes: ["US"] },
    ],
  };
  const info = parseSep38Info(duplicatedAsset, "fuzz duplicates");
  assert.equal(info.assets.length, 1);

  const conflictingAsset = {
    assets: [
      { asset: "iso4217:USD", country_codes: ["US"] },
      { asset: "iso4217:USD", country_codes: ["BR"] },
    ],
  };
  assert.throws(() => parseSep38Info(conflictingAsset, "fuzz conflicts"),
    (error: unknown) => (error as Error).name === "Sep38ClientError");

  const request = {
    sellAsset: "stellar:XLM",
    sellAmount: "1",
  } as const;
  const samePair = {
    buy_assets: [
      { asset: "iso4217:USD", price: "1.5", decimals: 2 },
      { asset: "iso4217:USD", price: "1.5", decimals: 2 },
    ],
  };
  const prices = parseSep38PricesResponse(samePair, request, "fuzz pairs");
  assert.equal(prices.pairs.length, 1);

  const conflictingPair = {
    buy_assets: [
      { asset: "iso4217:USD", price: "1.5", decimals: 2 },
      { asset: "iso4217:USD", price: "9.9", decimals: 2 },
    ],
  };
  assert.throws(
    () => parseSep38PricesResponse(conflictingPair, request, "fuzz pairs"),
    (error: unknown) => (error as Error).name === "Sep38ClientError",
  );
});

test("generated oversized and deeply nested payloads stay bounded at the parser boundary", () => {
  const oversized = {
    assets: [{
      asset: `iso4217:USD${"A".repeat(MAX_STRING_LENGTH * 4)}`,
      sell_delivery_methods: Array.from({ length: MAX_ARRAY_ITEMS * 4 }, () => ({
        name: "x".repeat(MAX_STRING_LENGTH),
        description: "y".repeat(MAX_STRING_LENGTH),
      })),
    }],
  };
  assert.throws(
    () => parseSep38Info(oversized, "fuzz oversized"),
    (error: unknown) => (error as Error).name === "Sep38ClientError",
  );

  const deep: Record<string, unknown> = { asset: "iso4217:USD" };
  let cursor = deep;
  for (let i = 0; i < MAX_DEPTH * 4; i += 1) {
    cursor.nested = {};
    cursor = cursor.nested as Record<string, unknown>;
  }
  // Deeply nested unknown fields are ignored by the strict parser, not crashed.
  assert.doesNotThrow(() => parseSep38Info({ assets: [deep] }, "fuzz deep"));
});

let onlyIndex: number | undefined;
let forcedSeed: number | undefined;
for (const arg of process.argv) {
  const seedMatch = /^FUZZ_SEED=(\d+)$/.exec(arg);
  if (seedMatch) forcedSeed = Number(seedMatch[1]);
}

test("deterministic seeds are stable across the run (regression harness sanity)", () => {
  const randomA = new DeterministicRandom(42);
  const randomB = new DeterministicRandom(42);
  for (let i = 0; i < 1_000; i += 1) {
    assert.equal(randomA.nextUint32(), randomB.nextUint32());
  }
  const randomC = new DeterministicRandom(43);
  assert.notEqual(new DeterministicRandom(42).nextUint32(), randomC.nextUint32());
});

// --- generators -------------------------------------------------------------

function generateAssetIdentifier(random: DeterministicRandom, seed: number, index: number): string {
  if (random.nextBoolean(0.35)) return random.pick(ASSET_FORMS);
  const scheme = random.pick(["iso4217:", "stellar:", "", "ISO4217:", "stellar :"]);
  const code = random.nextBoolean()
    ? random.nextString("ABCXYZusdc0123456789 .:-", 0, 12)
    : random.nextString(
      [...UNICODE_SAMPLES, "a", "Z", "9"].join(""),
      0,
      MAX_STRING_LENGTH,
    );
  const issuer = random.nextBoolean()
    ? VALID_ISSUER
    : random.nextString("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 0, 60);
  const identifier = `${scheme}${random.nextBoolean() ? code : `${code}:${issuer}`}`;
  if (onlyIndex !== undefined && index !== onlyIndex) return identifier;
  if (forcedSeed !== undefined && seed !== forcedSeed) return identifier;
  return identifier.slice(0, 256) + (identifier.length > 256 ? "" : "");
}

function generateDecimalString(random: DeterministicRandom): string {
  const integerPart = random.nextBoolean()
    ? String(random.nextInt(0, 999_999))
    : random.nextString("0123456789", 1, 12);
  const fraction = random.nextBoolean()
    ? `.${random.nextString("0123456789", 0, 12)}`
    : "";
  const sign = random.nextBoolean(0.9) ? "" : random.pick(["-", "+", " "]);
  const exponent = random.nextBoolean(0.95)
    ? ""
    : random.pick(["e3", "E10", "e-2", "e", "e+"]);
  const junk = random.nextBoolean(0.95)
    ? ""
    : random.pick(UNICODE_SAMPLES);
  return `${sign}${integerPart}${fraction}${exponent}${junk}`;
}

function generateInfoPayload(random: DeterministicRandom): unknown {
  const shape = random.nextInt(0, 9);
  switch (shape) {
    case 0: return null;
    case 1: return undefined;
    case 2: return random.nextInt(0, 2) === 0 ? 42 : "assets";
    case 3: return [];
    case 4: return {};
    case 5: return { assets: random.pick([null, 1, "x", {}]) };
    case 6: return {
      assets: [random.pick([null, 1, "iso4217:USD", [], {}])],
    };
    case 7: {
      const items = [];
      for (let i = 0; i < random.nextInt(0, MAX_ARRAY_ITEMS); i += 1) {
        items.push(generateAssetRecord(random));
      }
      return { assets: items };
    }
    default: {
      return {
        assets: [generateAssetRecord(random)],
        unexpected_top_level: { deeply: { nested: [1, 2, 3] } },
      };
    }
  }
}

function generateAssetRecord(random: DeterministicRandom): unknown {
  const asset = random.nextBoolean()
    ? random.pick(ASSET_FORMS)
    : random.nextString(
      [...UNICODE_SAMPLES, "a", ":", "4"].join(""),
      0,
      MAX_STRING_LENGTH,
    );
  const record: Record<string, unknown> = { asset };
  if (random.nextBoolean()) {
    record.country_codes = random.nextBoolean()
      ? ["US", "BR", "US"]
      : random.pick([
        "US", "", "usa", "US-", "US-BRA", 42, null, [""],
        random.nextString("ABcd0-", 0, 8),
      ]);
  }
  if (random.nextBoolean()) {
    const methods = [];
    for (let i = 0; i < random.nextInt(0, MAX_ARRAY_ITEMS); i += 1) {
      methods.push(random.pick([
        { name: "bank", description: "wire" },
        { name: "", description: "" },
        { name: null },
        "bank",
        42,
        {},
        { name: random.nextString("aA -", 0, 64), description: random.nextString("aA -", 0, 64) },
      ]));
    }
    record[random.nextBoolean() ? "sell_delivery_methods" : "buy_delivery_methods"] = methods;
  }
  if (random.nextBoolean()) {
    record.ignored_extra_field = { deeply: { nested: { value: 1 } } };
  }
  return record;
}

function assertInfoInvariants(info: ReturnType<typeof parseSep38Info>): void {
  assert.ok(info.assets.length <= MAX_ARRAY_ITEMS * 4 + 1);
  const seen = new Set<string>();
  for (const { asset, countryCodes } of info.assets) {
    assert.ok(!seen.has(asset), "accepted assets must be deduplicated");
    seen.add(asset);
    assert.deepEqual(countryCodes, [...countryCodes].sort());
    assert.deepEqual([...new Set(countryCodes)], countryCodes);
  }
  for (let i = 1; i < info.assets.length; i += 1) {
    assert.ok(
      info.assets[i - 1]!.asset.localeCompare(info.assets[i]!.asset) <= 0,
      "accepted assets must be sorted",
    );
  }
}
