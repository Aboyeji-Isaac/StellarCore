import assert from "node:assert/strict";
import test from "node:test";

import * as fc from "fast-check";

import { MIN_FRESH_SOURCES, RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import {
  compareDecimals,
  parseDatabaseDecimal,
} from "@/lib/rates/decimal";
import { computeFreshMedian } from "@/lib/rates/median";
import { selectLatestPerAnchor } from "@/lib/rates/latestRateReadModel";
import type { MedianSource } from "@/types/rates";
import type { LatestRateRepositoryObservation } from "@/types/latestRates";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const FRESH_MAX_AGE = RATE_FRESHNESS_THRESHOLD_MS;

/** Valid Decimal(38,18) rate strings the engine accepts (see lib/rates/decimal.ts). */
const validDecimal = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 19 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 18 }),
  )
  .filter(([, rest, fraction]) => 1 + rest.length + fraction.length <= 38)
  .map(([lead, rest, fraction]) =>
    `${lead}${rest.join("")}${fraction.length > 0 ? `.${fraction.join("")}` : ""}`,
  )
  .filter((value) => {
    try {
      parseDatabaseDecimal(value);
      return true;
    } catch {
      return false;
    }
  });

const slug = fc.string({ minLength: 2, maxLength: 16 });

/**
 * Observations that must never influence the median: stale rates (including
 * extreme outliers), future timestamps, and invalid rate values or timestamps.
 */
const outlierSource = fc
  .tuple(
    fc.tuple(
      slug,
      fc.oneof(
        fc.tuple(
          fc.constantFrom("stale"),
          fc.integer({ min: FRESH_MAX_AGE + 1, max: FRESH_MAX_AGE + 1_000_000 }),
        ),
        fc.tuple(fc.constantFrom("future"), fc.constantFrom(1)),
      ),
    ),
    fc.oneof(
      fc.constantFrom("999999999999999999.999999999999999999"),
      fc.constantFrom("0.000000000000000001"),
      fc.constantFrom("1e3"),
      fc.constantFrom("-5"),
      fc.constantFrom("0"),
    ),
  )
  .map(([[anchorSlug, [kind, ageMs]], rate]) => ({
    anchorSlug,
    corridorSlug: "prop-corridor",
    rate,
    capturedAt:
      kind === "stale" ? new Date(NOW_MS - ageMs) : new Date(NOW_MS + ageMs),
  }));

function freshSource(anchorSlug: string, rate: string, ageMs = 1_000): MedianSource {
  return {
    anchorSlug,
    corridorSlug: "prop-corridor",
    rate,
    capturedAt: new Date(NOW_MS - ageMs),
  };
}

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate,
    sourceAmount: "100",
    destinationAmount: "1",
    fee: "0",
    capturedAt,
  });
}

// ---------------------------------------------------------------------------
// Property 1 — a produced median always lies within the fresh value bounds,
// and stale/future/invalid observations can never move it.
// ---------------------------------------------------------------------------

test("property: median is bounded by the fresh values only", () => {
  fc.assert(fc.property(
    fc.tuple(
      fc.array(validDecimal, { minLength: 2, maxLength: 8 }),
      fc.uniqueArray(slug, { minLength: 12, maxLength: 12 }),
      fc.array(fc.integer({ min: 0, max: FRESH_MAX_AGE }), { minLength: 8, maxLength: 8 }),
      fc.array(outlierSource, { minLength: 0, maxLength: 6 }),
    ),
    ([freshValues, anchorSlugs, ages, outliers]) => {
      const sources: MedianSource[] = freshValues.map((value, index) =>
        freshSource(anchorSlugs[index]!, value, ages[index]!),
      );
      sources.push(...outliers);

      const result = computeFreshMedian(sources, NOW);
      if (result.state !== "healthy" || result.median === null) {
        return true;
      }

      const median = parseDatabaseDecimal(result.median);
      const decimals = freshValues.map((value) => parseDatabaseDecimal(value));
      const minimum = decimals.reduce((left, right) =>
        compareDecimals(left, right) <= 0 ? left : right);
      const maximum = decimals.reduce((left, right) =>
        compareDecimals(left, right) >= 0 ? left : right);

      assert.equal(compareDecimals(minimum, median) <= 0, true, "median below fresh minimum");
      assert.equal(compareDecimals(median, maximum) <= 0, true, "median above fresh maximum");
      assert.equal(result.freshSourceCount, freshValues.length, "stale entry contaminated count");
      return true;
    },
  ), { numRuns: 500 });
});

test("property: extreme stale outliers never move an exact two-source median", () => {
  fc.assert(fc.property(
    fc.array(outlierSource, { minLength: 0, maxLength: 8 }),
    (outliers) => {
      const result = computeFreshMedian([
        freshSource("a", "10"),
        freshSource("b", "20"),
        ...outliers,
      ], NOW);

      assert.equal(result.state, "healthy");
      assert.equal(result.median, "15");
      assert.equal(result.freshSourceCount, 2);
      return true;
    },
  ), { numRuns: 500 });
});

// ---------------------------------------------------------------------------
// Property 2 — fewer than MIN_FRESH_SOURCES fresh independent sources (each
// one observation per distinct anchor) can never produce a median.
// The MIN_FRESH_SOURCES - 1 boundary is generated explicitly.
// ---------------------------------------------------------------------------

test("property: insufficient fresh independent sources yield no median", () => {
  fc.assert(fc.property(
    fc.tuple(
      fc.oneof(fc.constantFrom(0), fc.constantFrom(MIN_FRESH_SOURCES - 1)),
      fc.uniqueArray(slug, { minLength: MIN_FRESH_SOURCES, maxLength: MIN_FRESH_SOURCES }),
      fc.array(validDecimal, { minLength: MIN_FRESH_SOURCES - 1, maxLength: MIN_FRESH_SOURCES - 1 }),
      fc.array(fc.integer({ min: 0, max: FRESH_MAX_AGE }), { minLength: MIN_FRESH_SOURCES - 1, maxLength: MIN_FRESH_SOURCES - 1 }),
      fc.array(outlierSource, { minLength: 0, maxLength: 6 }),
    ),
    ([freshCount, anchorSlugs, freshValues, ages, outliers]) => {
      const sources: MedianSource[] = anchorSlugs.slice(0, freshCount).map((anchorSlug, index) =>
        freshSource(anchorSlug, freshValues[index]!, ages[index]!),
      );
      sources.push(...outliers);

      const result = computeFreshMedian(sources, NOW);
      assert.equal(result.state, "insufficient_fresh_sources");
      assert.equal(result.median, null);
      assert.equal(result.freshSourceCount, freshCount);
      return true;
    },
  ), { numRuns: 500 });
});

// ---------------------------------------------------------------------------
// Property 3 — duplicates from one anchor must not count as independent
// sources. The identity semantics live in selectLatestPerAnchor (the layer
// that deduplicates before computeFreshMedian in the read path), so the
// property exercises the real composition.
// ---------------------------------------------------------------------------

test("property: same-anchor duplicates never inflate the fresh-source count", () => {
  fc.assert(fc.property(
    fc.tuple(
      fc.oneof(fc.constantFrom(1), fc.constantFrom(2), fc.constantFrom(3)),
      fc.uniqueArray(slug, { minLength: 3, maxLength: 3 }),
      fc.array(validDecimal, { minLength: 6, maxLength: 30 }),
      fc.array(fc.integer({ min: 0, max: FRESH_MAX_AGE }), { minLength: 6, maxLength: 30 }),
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 6, maxLength: 30 }),
    ),
    ([anchorCount, anchors, values, ages, ids]) => {
      // Observation count always exceeds the anchor count, so every anchor is
      // observed many times (min 6 observations across at most 3 anchors).
      const usedAnchors = anchors.slice(0, anchorCount);
      const history = values.map((value, index) =>
        observation(
          usedAnchors[index % usedAnchors.length]!,
          `${ids[index]}-row-${index}`,
          value,
          new Date(NOW_MS - ages[index]!),
        ),
      );

      const selected = selectLatestPerAnchor(history);
      const result = computeFreshMedian(selected.map(({ anchorSlug, rate, capturedAt }) => ({
        anchorSlug,
        corridorSlug: "prop-corridor",
        rate,
        capturedAt,
      })), NOW);

      // Every observation is fresh, so a fresh count above the number of
      // distinct anchors would prove duplicate counting.
      assert.equal(result.freshSourceCount, usedAnchors.length);
      assert.equal(
        result.freshSourceCount <= usedAnchors.length,
        true,
        "duplicate observations inflated the fresh-source count",
      );

      if (usedAnchors.length < MIN_FRESH_SOURCES) {
        assert.equal(result.state, "insufficient_fresh_sources");
        assert.equal(result.median, null);
      }
      return true;
    },
  ), { numRuns: 500 });
});

// ---------------------------------------------------------------------------
// Fallback behavior: lib/rates/median.ts has no fallback chain. When the
// fresh-source minimum is not met the result is always
// { state: "insufficient_fresh_sources", median: null }. No tests are written
// for fallback behavior that does not exist.
// ---------------------------------------------------------------------------