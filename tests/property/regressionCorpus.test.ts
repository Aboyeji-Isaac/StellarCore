import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Sep1DiscoveryError, parseSep1Toml } from "@/lib/stellar/sep1";
import {
  parseSep38AssetIdentifier,
  parseSep38FirmQuote,
  parseSep38IndicativePrice,
  parseSep38Info,
  parseSep38PricesResponse,
  Sep38ClientError,
} from "@/lib/stellar/sep38";

/**
 * Persisted regression corpus for discovered parser failures (#141).
 *
 * Directory layout (fixtures are minimized by hand from fuzz findings):
 *   tests/property/regressions/sep1/<name>.toml   — raw TOML body
 *   tests/property/regressions/sep38/<name>.json  — JSON response body
 *   tests/property/regressions/<name>.expect.json — expected outcome contract
 *
 * Each expectation file pins:
 *   { "parser": "sep1" | "sep38", "kind": "...", "error": "<CODE>" | null }
 *
 * Adding a fixture: when the fuzzer finds a parser crash or invariant
 * violation, minimize the input, save it here, and record the typed outcome.
 * The suite then asserts the exact expected outcome forever after, so a
 * regression of a fixed parser bug cannot silently reintroduce itself.
 */

const REGRESSION_ROOT = join(import.meta.dirname, "regressions");

const EXPECTATION_BY_FIXTURE = new Map<string, { error: string | null; invariant?: string }>(loadExpectations());

function loadExpectations(): Array<[string, { error: string | null; invariant?: string }]> {
  // Expectations are declared inline below rather than parsed from disk, so a
  // malformed expectations file can never mask a regression.
  return [
    // Corpus seeded with the structural cases the fuzzer explores. Each pins
    // a parser decision that must not change unnoticed.
    ["sep1/invalid-array-document.toml", { error: "INVALID_TOML" }],
    ["sep1/https-only-endpoints.toml", { error: "INVALID_DATA" }],
    ["sep1/minimal-valid.toml", { error: null, invariant: "frozen-and-normalized" }],
    ["sep1/duplicate-currency.toml", { error: null, invariant: "assets-preserved" }],
    ["sep1/type-confused-network-passphrase.toml", { error: "MISSING_REQUIRED_DATA" }],
    ["sep38/info-conflicting-duplicates.json", { error: "INVALID_DATA" }],
    ["sep38/info-identical-duplicates-dedupe.json", { error: null, invariant: "assets-deduped" }],
    ["sep38/info-malformed-asset-identifier.json", { error: "INVALID_ASSET" }],
    ["sep38/prices-negative-decimals.json", { error: "INVALID_DATA" }],
    ["sep38/price-float-coercion.json", { error: "INVALID_DATA" }],
    ["sep38/quote-invalid-expires-at.json", { error: "INVALID_DATA" }],
    ["sep38/asset-escape-sequence.json", { error: null, invariant: "asset-decoded" }],
    ["sep38/asset-invalid-issuer-checksum.json", { error: "INVALID_ASSET" }],
    ["sep38/asset-escaped-colon.json", { error: null, invariant: "asset-colon-decoded" }],
  ];
}

test("every persisted regression fixture still produces its recorded typed outcome", () => {
  assert.equal(existsSync(REGRESSION_ROOT), true, "regression corpus directory is missing");

  for (const [fixture, expected] of EXPECTATION_BY_FIXTURE) {
    const [parser, ...rest] = fixture.split("/");
    const path = join(REGRESSION_ROOT, fixture);
    assert.equal(existsSync(path), true, `missing fixture: ${fixture}`);
    const raw = readFileSync(path, "utf8");

    switch (parser) {
      case "sep1":
        assertSep1Outcome(rest.join("/"), raw, expected, fixture);
        break;
      case "sep38":
        assertSep38Outcome(rest.join("/"), raw, expected, fixture);
        break;
      default:
        assert.fail(`unknown parser prefix in ${fixture}`);
    }
  }
});

test("no orphan fixtures: every file in the corpus has a pinned expectation", () => {
  for (const parser of ["sep1", "sep38"] as const) {
    const directory = join(REGRESSION_ROOT, parser);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)) {
      const fixture = `${parser}/${file}`;
      assert.ok(
        EXPECTATION_BY_FIXTURE.has(fixture),
        `fixture ${fixture} has no pinned expectation`,
      );
    }
  }
});

function assertSep1Outcome(
  _name: string,
  raw: string,
  expected: { error: string | null; invariant?: string },
  fixture: string,
): void {
  try {
    const data = parseSep1Toml(raw, "regression://corpus");
    assert.equal(expected.error, null, `${fixture}: expected error ${expected.error}, got success`);
    if (expected.invariant === "frozen-and-normalized") {
      assert.equal(Object.isFrozen(data), true);
      assert.ok(data.organizationName.length > 0);
    }
    if (expected.invariant === "assets-preserved") {
      assert.ok(data.assets.length >= 2, `${fixture}: assets must survive`);
    }
  } catch (error) {
    assert.ok(error instanceof Sep1DiscoveryError, `${fixture}: untyped failure ${String(error)}`);
    assert.equal(error.code, expected.error, `${fixture}: unexpected error code`);
  }
}

function assertSep38Outcome(
  name: string,
  raw: string,
  expected: { error: string | null; invariant?: string },
  fixture: string,
): void {
  const value = JSON.parse(raw) as unknown;
  try {
    switch (name) {
      case "info-conflicting-duplicates.json":
      case "info-identical-duplicates-dedupe.json":
      case "info-malformed-asset-identifier.json": {
        const info = parseSep38Info(value, "regression://corpus");
        assert.equal(expected.error, null, `${fixture}: expected error, got success`);
        if (expected.invariant === "assets-deduped") {
          const seen = new Set<string>();
          for (const asset of info.assets) assert.equal(seen.has(asset.asset), false);
          for (const asset of info.assets) seen.add(asset.asset);
        }
        return;
      }
      case "prices-negative-decimals.json": {
        const prices = parseSep38PricesResponse(
          value,
          { sellAsset: "iso4217:USD", sellAmount: "10" },
          "regression://corpus",
        );
        assert.equal(expected.error, null, `${fixture}: expected error, got success`);
        for (const pair of prices.pairs) assert.ok(pair.decimals >= 0);
        return;
      }
      case "price-float-coercion.json": {
        const price = parseSep38IndicativePrice(
          value,
          { sellAsset: "iso4217:USD", buyAsset: "iso4217:BRL", sellAmount: "1", context: "sep6" },
          "regression://corpus",
        );
        assert.equal(expected.error, null, `${fixture}: expected error, got success`);
        assert.equal(typeof price.price, "string");
        return;
      }
      case "quote-invalid-expires-at.json": {
        parseSep38FirmQuote(value, "regression://corpus");
        assert.equal(expected.error, null, `${fixture}: expected error, got success`);
        return;
      }
      case "asset-escape-sequence.json":
      case "asset-escaped-colon.json":
      case "asset-invalid-issuer-checksum.json": {
        const identifier = (value as { asset: string }).asset;
        const parsed = parseSep38AssetIdentifier(identifier);
        assert.equal(expected.error, null, `${fixture}: expected error, got success`);
        if (expected.invariant === "asset-decoded") {
          assert.equal(parsed.code, "codeA");
        }
        if (expected.invariant === "asset-colon-decoded") {
          assert.equal(parsed.code, "A:B");
        }
        return;
      }
      default:
        assert.fail(`no runner wired for fixture ${fixture}`);
    }
  } catch (error) {
    assert.ok(error instanceof Sep38ClientError, `${fixture}: untyped failure ${String(error)}`);
    assert.equal(error.code, expected.error, `${fixture}: unexpected error code`);
  }
}
