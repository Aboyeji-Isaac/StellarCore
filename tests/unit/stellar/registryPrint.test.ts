import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRegistrySummary,
  currentRegistrySummary,
  formatRegistrySummary,
  type RegistrySummary,
} from "@/lib/stellar/registryPrint";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const ANCHOR_A = Object.freeze({
  slug: "anchor-a",
  name: "Anchor A",
  homeDomain: "anchor-a.example.com",
}) satisfies AnchorRegistryEntry;

const ANCHOR_B = Object.freeze({
  slug: "anchor-b",
  name: "Anchor B",
  homeDomain: "anchor-b.example.com",
}) satisfies AnchorRegistryEntry;

const BRL_CORRIDOR = Object.freeze({
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
}) satisfies CorridorRegistryEntry;

const USD_CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;

function sourceFor(
  corridor: CorridorRegistryEntry,
  overrides: Partial<ReviewedLiveRateSource> = {},
): ReviewedLiveRateSource {
  return Object.freeze({
    anchorSlug: ANCHOR_A.slug,
    corridorSlug: corridor.slug,
    sellAsset: `stellar:${corridor.assetCodeFrom}:${ISSUER}`,
    buyAsset: `iso4217:${corridor.assetCodeTo}`,
    sellAmount: "100",
    countryCode: corridor.countryTo,
    context: "sep31",
    ...overrides,
  }) as ReviewedLiveRateSource;
}

function summaryFrom(overrides: {
  anchors?: readonly AnchorRegistryEntry[];
  corridors?: readonly CorridorRegistryEntry[];
  mappings?: readonly AnchorCorridorRegistryEntry[];
  sources?: readonly ReviewedLiveRateSource[];
} = {}): RegistrySummary {
  return buildRegistrySummary({
    anchors: overrides.anchors ?? [ANCHOR_A],
    corridors: overrides.corridors ?? [BRL_CORRIDOR],
    anchorCorridorMappings: overrides.mappings
      ?? [Object.freeze({ anchorSlug: ANCHOR_A.slug, corridorSlugs: [BRL_CORRIDOR.slug] })],
    reviewedLiveRateSources: overrides.sources ?? [sourceFor(BRL_CORRIDOR)],
  });
}

test("summary includes every anchor with its home domain and mapped corridors", () => {
  const summary = summaryFrom({
    anchors: [ANCHOR_A, ANCHOR_B],
    mappings: [
      { anchorSlug: ANCHOR_A.slug, corridorSlugs: [BRL_CORRIDOR.slug] },
      { anchorSlug: ANCHOR_B.slug, corridorSlugs: [USD_CORRIDOR.slug] },
    ],
    corridors: [BRL_CORRIDOR, USD_CORRIDOR],
  });

  assert.deepEqual(
    summary.anchors.map((anchor) => [anchor.slug, anchor.homeDomain, anchor.corridorSlugs]),
    [
      ["anchor-a", "anchor-a.example.com", ["usdc-us-brl-br"]],
      ["anchor-b", "anchor-b.example.com", ["usdc-us-usd-us"]],
    ],
  );
});

test("anchor without a membership mapping shows no corridors", () => {
  const summary = summaryFrom({ mappings: [] });

  assert.equal(summary.anchors[0].corridorSlugs.length, 0);
  assert.equal(summary.corridors[0].anchorSlugs.length, 0);
});

test("corridor summary reports the canonical route and shared anchors", () => {
  const summary = summaryFrom({
    anchors: [ANCHOR_A, ANCHOR_B],
    mappings: [
      { anchorSlug: ANCHOR_A.slug, corridorSlugs: [BRL_CORRIDOR.slug] },
      { anchorSlug: ANCHOR_B.slug, corridorSlugs: [BRL_CORRIDOR.slug] },
    ],
  });

  assert.equal(summary.corridors[0].route, "USDC (US) -> BRL (BR)");
  assert.deepEqual(summary.corridors[0].anchorSlugs, ["anchor-a", "anchor-b"]);
});

test("corridor flagged only when a reviewed rate source targets it", () => {
  const withSource = summaryFrom();
  const withoutSource = summaryFrom({ sources: [] });

  assert.equal(withSource.corridors[0].hasReviewedRateSource, true);
  assert.equal(withoutSource.corridors[0].hasReviewedRateSource, false);
});

test("reviewed rate source counts are per anchor", () => {
  const summary = summaryFrom({
    sources: [
      sourceFor(BRL_CORRIDOR),
      sourceFor(BRL_CORRIDOR, { corridorSlug: USD_CORRIDOR.slug, buyAsset: "iso4217:USD" }),
    ],
  });

  assert.equal(summary.anchors[0].reviewedRateSourceCount, 2);
});

test("current registry summary matches the checked-in registries", () => {
  const summary = currentRegistrySummary();

  // Registry order is preserved as checked in, not resorted.
  assert.deepEqual(
    summary.anchors.map((anchor) => anchor.slug),
    ["moneygram", "cowrie", "zeam"],
  );
  assert.deepEqual(
    summary.corridors.map((corridor) => corridor.slug),
    ["usdc-us-usd-us", "ngnt-ng-ngn-ng", "usdc-us-brl-br"],
  );
  assert.equal(summary.reviewedRateSources.length, 1);
  assert.equal(summary.reviewedRateSources[0].anchorSlug, "zeam");
});

test("formatting renders anchors, corridors, and the SEP evidence note", () => {
  const text = formatRegistrySummary(summaryFrom());

  assert.match(text, /Anchor A \(anchor-a\)/);
  assert.match(text, /home domain: anchor-a\.example\.com/);
  assert.match(text, /corridors:\s+usdc-us-brl-br/);
  assert.match(text, /usdc-us-brl-br/);
  assert.match(text, /route:\s+USDC \(US\) -> BRL \(BR\)/);
  assert.match(text, /reviewed rate source: yes/);
  assert.match(text, /SEP support is discovered|does not store SEP support/);
  assert.match(text, /1 anchor\(s\), 1 corridor\(s\), 1 reviewed live rate source\(s\)\./);
});

test("formatting shows (none) for anchors or corridors without mappings", () => {
  const text = formatRegistrySummary(summaryFrom({ mappings: [], sources: [] }));

  assert.match(text, /corridors:\s+\(none\)/);
  assert.match(text, /anchors: \(none\)/);
  assert.match(text, /reviewed rate source: no/);
});

test("summary and all nested entries are deeply frozen", () => {
  const summary = summaryFrom();

  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.anchors), true);
  assert.equal(Object.isFrozen(summary.anchors[0]), true);
  assert.equal(Object.isFrozen(summary.anchors[0].corridorSlugs), true);
  assert.equal(Object.isFrozen(summary.corridors), true);
  assert.equal(Object.isFrozen(summary.corridors[0]), true);
  assert.equal(Object.isFrozen(summary.reviewedRateSources[0]), true);
  assert.throws(() => {
    (summary.anchors as unknown as unknown[]).push({});
  }, TypeError);
});

test("formatting output is deterministic for the current registry", () => {
  assert.equal(
    formatRegistrySummary(currentRegistrySummary()),
    formatRegistrySummary(currentRegistrySummary()),
  );
});
