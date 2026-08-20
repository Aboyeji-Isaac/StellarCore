import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAnchorCorridorRegistry,
  validateCorridorRegistry,
} from "@/lib/stellar/corridorRegistry";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

const CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;

const ANCHOR = Object.freeze({
  slug: "moneygram",
  name: "MoneyGram",
  homeDomain: "mgxanchor.moneygram.com",
}) satisfies AnchorRegistryEntry;

test("corridor registry validation accepts normalized entries and mappings", () => {
  const mapping = Object.freeze({
    anchorSlug: ANCHOR.slug,
    corridorSlugs: Object.freeze([CORRIDOR.slug]),
  }) satisfies AnchorCorridorRegistryEntry;

  assert.doesNotThrow(() => validateCorridorRegistry([CORRIDOR]));
  assert.doesNotThrow(() =>
    validateAnchorCorridorRegistry([mapping], [CORRIDOR], [ANCHOR]),
  );
});

test("corridor registry validation rejects duplicate slugs", () => {
  assert.throws(
    () => validateCorridorRegistry([CORRIDOR, { ...CORRIDOR }]),
    /Duplicate corridor slug/,
  );
});

test("corridor registry validation rejects malformed normalized fields", () => {
  assert.throws(
    () =>
      validateCorridorRegistry([
        { ...CORRIDOR, slug: "Invalid Slug" },
      ]),
    /Invalid corridor slug/,
  );
  assert.throws(
    () => validateCorridorRegistry([{ ...CORRIDOR, assetCodeFrom: "" }]),
    /invalid assetCodeFrom/,
  );
  assert.throws(
    () => validateCorridorRegistry([{ ...CORRIDOR, countryTo: "USA" }]),
    /invalid countryTo/,
  );
});

test("association registry validation rejects unknown and duplicate mappings", () => {
  const mapping = Object.freeze({
    anchorSlug: ANCHOR.slug,
    corridorSlugs: Object.freeze([CORRIDOR.slug]),
  }) satisfies AnchorCorridorRegistryEntry;

  assert.throws(
    () =>
      validateAnchorCorridorRegistry(
        [{ anchorSlug: "unknown", corridorSlugs: [CORRIDOR.slug] }],
        [CORRIDOR],
        [ANCHOR],
      ),
    /Unknown anchor slug/,
  );
  assert.throws(
    () =>
      validateAnchorCorridorRegistry(
        [mapping, { ...mapping }],
        [CORRIDOR],
        [ANCHOR],
      ),
    /Duplicate anchor mapping/,
  );
});
