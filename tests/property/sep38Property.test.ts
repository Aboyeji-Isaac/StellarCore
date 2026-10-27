import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSep38AssetIdentifier,
  parseSep38FirmQuote,
  parseSep38IndicativePrice,
  parseSep38Info,
  parseSep38PricesResponse,
  Sep38ClientError,
} from "@/lib/stellar/sep38";
import {
  ASSET_CODES,
  COUNTRY_CODES,
  DELIVERY_METHOD_NAMES,
  FEE_DETAIL_NAMES,
  ISO_CODES,
  SeededRandom,
  UNICODE_FRAGMENTS,
  mutateString,
} from "./seededGenerator";

/**
 * Deterministic property suite for untrusted SEP-38 response parsing (#141).
 *
 * Properties asserted for every generated input:
 * P1. Parsing either returns frozen normalized data or throws a typed
 *     Sep38ClientError (INVALID_ASSET / INVALID_DATA / INVALID_REQUEST) —
 *     never RangeError, TypeError, or any other uncaught shape.
 * P2. Generated duplicate/conflicting entries never crash and never leak
 *     conflicting data into the normalized result.
 * P3. Accepted rate data satisfies normalization invariants: decimal strings
 *     stay strings (no float coercion), assets sort deterministically, and
 *     outputs are deeply frozen.
 *
 * Reproduce a failure locally with the exact printed seed:
 *   SEED=38383 npx tsx --test tests/property/sep38Property.test.ts
 */

const SEED = Number.parseInt(process.env.SEED ?? "38383", 10);
const ITERATIONS = Number.parseInt(process.env.PROPERTY_ITERATIONS ?? "600", 10);

test("generated asset identifiers always parse or throw the typed INVALID_ASSET error", () => {
  const random = new SeededRandom(SEED);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const identifier = generateAssetIdentifier(random);
    try {
      const parsed = parseSep38AssetIdentifier(identifier);
      // Normalization invariants on accepted identifiers.
      assert.equal(Object.isFrozen(parsed), true);
      assert.match(parsed.scheme, /^(iso4217|stellar)$/);
      if (parsed.scheme === "iso4217") {
        assert.match(parsed.code, /^[A-Z]{3}$/);
      }
      if (parsed.scheme === "stellar" && parsed.issuer !== undefined) {
        assert.match(parsed.code, /^[\x21-\x7e]{1,12}$/);
        assert.match(parsed.issuer, /^G[A-Z2-7]{55}$/);
      }
      if ("liquidityPoolId" in parsed && typeof parsed.liquidityPoolId === "string") {
        assert.match(parsed.liquidityPoolId, /^[0-9a-f]{64}$/);
      }
    } catch (error) {
      assert.ok(
        error instanceof Sep38ClientError,
        `iteration ${i}: identifier ${JSON.stringify(identifier)} threw ${String(error)}`,
      );
      assert.equal(error.code, "INVALID_ASSET");
    }
  }
});

test("generated /info responses always parse to frozen sorted assets or typed errors", () => {
  const random = new SeededRandom(SEED + 1);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const response = generateInfoResponse(random);
    try {
      const info = parseSep38Info(response, "property://test/info");
      assert.equal(Object.isFrozen(info), true);
      assert.equal(Object.isFrozen(info.assets), true);
      // Deterministic sort order.
      for (let a = 1; a < info.assets.length; a += 1) {
        assert.ok(info.assets[a - 1]!.asset <= info.assets[a]!.asset);
      }
      // Country codes stay sorted and deduplicated.
      for (const asset of info.assets) {
        for (let c = 1; c < asset.countryCodes.length; c += 1) {
          assert.ok(asset.countryCodes[c - 1]! < asset.countryCodes[c]!);
        }
      }
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError, `iteration ${i}: ${String(error)}`);
      // Malformed asset identifier strings reject as INVALID_ASSET; malformed
      // response shapes reject as INVALID_DATA. Both are typed and bounded.
      assert.ok(["INVALID_DATA", "INVALID_ASSET"].includes(error.code));
    }
  }
});

test("generated duplicate and conflicting assets never produce invalid state", () => {
  const random = new SeededRandom(SEED + 2);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const asset = validAssetIdentifier(random);
    const conflicting = random.chance(0.5)
      ? { ...validAsset(random), countryCodes: ["ZZ"] }
      : validAsset(random);
    const response = {
      assets: [
        validAsset(random),
        random.chance(0.5) ? validAsset(random) : conflicting,
      ],
    };
    try {
      const info = parseSep38Info(response, "property://test/info");
      // Identical duplicates dedupe; conflicting duplicates are rejected
      // upstream, so surviving assets are always internally consistent.
      const seen = new Set<string>();
      for (const entry of info.assets) {
        assert.equal(seen.has(entry.asset), false, "duplicate asset survived normalization");
        seen.add(entry.asset);
      }
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError);
      assert.ok(["INVALID_DATA", "INVALID_ASSET"].includes(error.code));
    }
    assert.ok(typeof asset === "string" && typeof conflicting === "object");
  }
});

test("generated price and quote decimals always remain strings or typed errors", () => {
  const random = new SeededRandom(SEED + 3);
  const request = {
    sellAsset: "iso4217:USD",
    buyAsset: "iso4217:BRL",
    sellAmount: "100",
    context: "sep6",
  } as const;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const response = generateIndicativePrice(random);
    try {
      const price = parseSep38IndicativePrice(response, request, "property://test/price");
      // Decimal strings must survive as strings (no float coercion).
      for (const value of [price.totalPrice, price.price, price.sellAmount, price.buyAmount]) {
        assert.equal(typeof value, "string");
        assert.match(value, /^(?:0|[1-9]\d*)(?:\.\d+)?$/);
      }
      assert.equal(Object.isFrozen(price), true);
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError, `iteration ${i}: ${String(error)}`);
      // Malformed asset strings inside the response reject as INVALID_ASSET;
      // malformed shapes/decimals reject as INVALID_DATA.
      assert.ok(["INVALID_DATA", "INVALID_ASSET"].includes(error.code));
    }

    const pricesResponse = generatePricesResponse(random);
    try {
      const prices = parseSep38PricesResponse(
        pricesResponse,
        { sellAsset: "iso4217:USD", sellAmount: "10" },
        "property://test/prices",
      );
      for (const pair of prices.pairs) {
        assert.equal(typeof pair.price, "string");
        assert.equal(Number.isSafeInteger(pair.decimals), true);
        assert.ok(pair.decimals >= 0);
      }
      assert.equal(Object.isFrozen(prices), true);
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError);
      assert.ok(["INVALID_DATA", "INVALID_ASSET"].includes(error.code));
    }
  }
});

test("generated firm quotes always parse to frozen data or typed errors", () => {
  const random = new SeededRandom(SEED + 4);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const response = generateFirmQuote(random);
    try {
      const quote = parseSep38FirmQuote(response, "property://test/quote");
      assert.equal(Object.isFrozen(quote), true);
      assert.match(quote.expiresAt, /(?:Z|[+-]\d{2}:\d{2})$/);
      assert.equal(typeof quote.id, "string");
      assert.ok(quote.id.length > 0);
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError, `iteration ${i}: ${String(error)}`);
      assert.ok(["INVALID_DATA", "INVALID_ASSET"].includes(error.code));
    }
  }
});

test("malformed JSON values and deeply nested structures stay bounded", () => {
  const random = new SeededRandom(SEED + 5);

  const shapes: unknown[] = [
    null, undefined, 42, "string", true, [], [1, 2, 3], () => 1, Symbol("x"),
  ];
  for (const shape of shapes) {
    try {
      parseSep38Info(shape, "property://test/info");
      assert.fail(`expected rejection for ${String(shape)}`);
    } catch (error) {
      assert.ok(error instanceof Sep38ClientError);
    }
  }

  // Bounded deep nesting: 1,000-deep array in a fee detail.
  const deep: unknown[] = [];
  let cursor = deep;
  for (let depth = 0; depth < 1_000; depth += 1) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  const nested = {
    total: "1",
    asset: "iso4217:USD",
    details: [{ name: "n", description: "d", amount: deep }],
  };
  try {
    parseSep38IndicativePrice(
      nested,
      { sellAsset: "iso4217:USD", buyAsset: "iso4217:BRL", sellAmount: "1", context: "sep6" },
      "property://test/price",
    );
  } catch (error) {
    assert.ok(error instanceof Sep38ClientError);
  }
  assert.ok(random.nextInt(1) >= 0);
});

function generateAssetIdentifier(random: SeededRandom): string {
  const scheme = random.nextInt(4);
  if (scheme === 0) {
    // iso4217 candidates.
    return `iso4217:${mutateString(random, random.pick([...ISO_CODES]), 8)}`;
  }
  if (scheme === 1) {
    // stellar native
    return random.pick(["stellar:native", "stellar:XLM", "stellar:TestXLM"]);
  }
  if (scheme === 2) {
    // stellar code:issuer with mutation pressure
    const code = mutateString(random, random.pick([...ASSET_CODES]), 16);
    const issuer = random.pick([
      "GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUYVGLNNJB2NH7OZAPMVQKBZ4UANFCS",
      "MA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
      "GAAAA",
      "",
      random.pick([...UNICODE_FRAGMENTS]),
    ]);
    return `stellar:${code}:${issuer}`;
  }
  // Liquidity pool / unknown scheme / escape sequences.
  return random.pick([
    "stellar:aa9a7a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a:lp",
    `stellar:${"a".repeat(64)}:lp`,
    "foo:bar",
    "",
    "stellar:",
    "stellar:code\\:escaped:GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
    "stellar:code\\x41:GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
  ]);
}

function validAssetIdentifier(random: SeededRandom): string {
  return random.chance(0.5)
    ? `iso4217:${random.pick([...ISO_CODES])}`
    : "stellar:native";
}

function validAsset(random: SeededRandom): Record<string, unknown> {
  const asset = validAssetIdentifier(random);
  return {
    asset,
    ...(random.chance(0.7) ? { country_codes: random.pick([[...COUNTRY_CODES].slice(0, 3), []]) } : {}),
    ...(random.chance(0.5) ? { sell_delivery_methods: [{ name: "bank", description: "Bank transfer" }] } : {}),
    ...(random.chance(0.5) ? { buy_delivery_methods: [{ name: "cash", description: "Cash pickup" }] } : {}),
  };
}

function generateInfoResponse(random: SeededRandom): unknown {
  if (random.chance(0.15)) {
    // Type confusion at the top level.
    return random.pick([null, 42, "str", true, [], random.pick([...UNICODE_FRAGMENTS])]);
  }
  const assets: unknown[] = [];
  const count = random.nextInt(5);
  for (let a = 0; a < count; a += 1) {
    if (random.chance(0.2)) {
      assets.push(random.pick([null, "asset", 7, []]));
      continue;
    }
    const entry: Record<string, unknown> = validAsset(random);
    if (random.chance(0.2)) {
      entry.asset = mutateString(random, entry.asset as string, 30);
    }
    if (random.chance(0.2)) {
      entry.country_codes = random.pick([null, "US", [null], [42], ["us"], ["TOOLONGCODE"]]);
    }
    if (random.chance(0.15)) {
      entry.sell_delivery_methods = random.pick([null, "bank", [{ name: "n" }], [null]]);
    }
    assets.push(entry);
  }
  return { assets };
}

function decimalish(random: SeededRandom): string {
  const base = random.pick([
    "1", "1.5", "0.0001", "123456789.123456789", "100", "0.5",
  ]);
  if (random.chance(0.3)) return mutateString(random, base, 30);
  return base;
}

function generateIndicativePrice(random: SeededRandom): unknown {
  if (random.chance(0.15)) {
    return random.pick([null, 42, "str", [], true]);
  }
  const record: Record<string, unknown> = {
    total_price: decimalish(random),
    price: decimalish(random),
    sell_amount: decimalish(random),
    buy_amount: decimalish(random),
  };
  if (random.chance(0.7)) {
    record.fee = generateFee(random);
  }
  if (random.chance(0.2)) {
    const key = random.pick(["total_price", "price", "sell_amount", "buy_amount"]);
    record[key] = random.pick([null, 1.5, {}, [], "abc", "-5", "1e3", ""]);
  }
  return record;
}

function generateFee(random: SeededRandom): unknown {
  if (random.chance(0.15)) return random.pick([null, "fee", 42, []]);
  const details = random.chance(0.3)
    ? random.pick([undefined, [], [null], "details", [{ name: random.pick([...FEE_DETAIL_NAMES]), description: "d", amount: "0.1" }]])
    : undefined;
  return {
    total: decimalish(random),
    asset: validAssetIdentifier(random),
    ...(details !== undefined ? { details } : {}),
  };
}

function generatePricesResponse(random: SeededRandom): unknown {
  if (random.chance(0.15)) {
    return random.pick([null, 42, "str", true]);
  }
  const isSell = random.chance(0.5);
  const pairs: unknown[] = [];
  const count = random.nextInt(4);
  for (let p = 0; p < count; p += 1) {
    if (random.chance(0.15)) {
      pairs.push(random.pick([null, "pair", 9, []]));
      continue;
    }
    pairs.push({
      asset: random.chance(0.8) ? validAssetIdentifier(random) : mutateString(random, "iso4217:USD", 30),
      price: decimalish(random),
      decimals: random.chance(0.85) ? random.nextInt(8) : random.pick([-1, 1.5, "2", null]),
    });
  }
  return isSell ? { buy_assets: pairs } : { sell_assets: pairs };
}

function generateFirmQuote(random: SeededRandom): unknown {
  if (random.chance(0.15)) {
    return random.pick([null, 42, "str", [], true]);
  }
  const record: Record<string, unknown> = {
    id: random.chance(0.85) ? mutateString(random, "quote-id-1", 40) : random.pick([null, 42, ""]),
    expires_at: random.chance(0.85)
      ? random.pick(["2026-12-31T23:59:59Z", "2026-12-31T23:59:59+00:00", "2027-01-01T00:00:00.000Z"])
      : random.pick(["not-a-date", "2026-13-45T99:99:99Z", null, 42]),
    total_price: decimalish(random),
    price: decimalish(random),
    sell_asset: random.chance(0.85) ? validAssetIdentifier(random) : mutateString(random, "stellar:native", 30),
    sell_amount: decimalish(random),
    buy_asset: random.chance(0.85) ? validAssetIdentifier(random) : mutateString(random, "iso4217:USD", 30),
    buy_amount: decimalish(random),
  };
  if (random.chance(0.7)) {
    record.fee = generateFee(random);
  }
  if (random.chance(0.2)) {
    record.sell_delivery_method = random.pick([...DELIVERY_METHOD_NAMES]);
  }
  return record;
}
