import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FRESH_SOURCES,
  RATE_FRESHNESS_THRESHOLD_MS,
} from "@/constants/rates";
import { computeFreshMedian } from "@/lib/rates/median";
import { selectLatestPerAnchor } from "@/lib/rates/latestRateReadModel";
import type { LatestRateRepositoryObservation } from "@/types/latestRates";
import type { MedianSource } from "@/types/rates";

const NOW = new Date("2026-09-26T12:00:00.000Z");

function rng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function randomInt(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

test("random fresh-source medians always stay within the fresh min/max bounds", () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    const next = rng(seed);
    const count = randomInt(next, MIN_FRESH_SOURCES, 12);
    const values = Array.from({ length: count }, () => randomInt(next, 1, 1_000_000));
    const sources: MedianSource[] = values.map((value, index) => ({
      anchorSlug: `anchor-${index}`,
      corridorSlug: "usdc-us-brl-br",
      rate: String(value),
      capturedAt: new Date(
        NOW.getTime() - randomInt(next, 0, RATE_FRESHNESS_THRESHOLD_MS),
      ),
    }));

    const result = computeFreshMedian(sources, NOW);
    assert.equal(result.state, "healthy");
    assert.ok(result.median !== null);

    const median = Number(result.median);
    assert.ok(median >= Math.min(...values));
    assert.ok(median <= Math.max(...values));
    assert.equal(result.freshSourceCount, count);
  }
});

test("stale and future outliers never influence a healthy fresh median", () => {
  for (let seed = 251; seed <= 400; seed += 1) {
    const next = rng(seed);
    const low = randomInt(next, 100, 500);
    const high = randomInt(next, 501, 1_000);
    const fresh: MedianSource[] = [
      {
        anchorSlug: "fresh-a",
        corridorSlug: "usdc-us-brl-br",
        rate: String(low),
        capturedAt: NOW,
      },
      {
        anchorSlug: "fresh-b",
        corridorSlug: "usdc-us-brl-br",
        rate: String(high),
        capturedAt: NOW,
      },
    ];
    const excluded: MedianSource[] = [
      {
        anchorSlug: "stale-outlier",
        corridorSlug: "usdc-us-brl-br",
        rate: "999999999",
        capturedAt: new Date(
          NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS - randomInt(next, 1, 10_000),
        ),
      },
      {
        anchorSlug: "future-outlier",
        corridorSlug: "usdc-us-brl-br",
        rate: "1",
        capturedAt: new Date(NOW.getTime() + randomInt(next, 1, 10_000)),
      },
    ];

    const baseline = computeFreshMedian(fresh, NOW);
    const withOutliers = computeFreshMedian([...fresh, ...excluded], NOW);
    assert.equal(withOutliers.state, "healthy");
    assert.equal(withOutliers.median, baseline.median);
    assert.equal(withOutliers.freshSourceCount, fresh.length);
  }
});

test("fewer than MIN_FRESH_SOURCES never publishes a median", () => {
  for (let count = 0; count < MIN_FRESH_SOURCES; count += 1) {
    for (let seed = 1; seed <= 100; seed += 1) {
      const next = rng(seed + count * 1000);
      const sources: MedianSource[] = Array.from({ length: count }, (_, index) => ({
        anchorSlug: `anchor-${index}`,
        corridorSlug: "usdc-us-brl-br",
        rate: String(randomInt(next, 1, 100_000)),
        capturedAt: NOW,
      }));
      const result = computeFreshMedian(sources, NOW);
      assert.equal(result.state, "insufficient_fresh_sources");
      assert.equal(result.median, null);
      assert.equal(result.freshSourceCount, count);
    }
  }
});

test("multiple observations from one anchor collapse before independent-source counting", () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const next = rng(seed);
    const history: LatestRateRepositoryObservation[] = Array.from(
      { length: randomInt(next, 2, 10) },
      (_, index) => ({
        id: `row-${String(index).padStart(2, "0")}`,
        anchorSlug: "same-anchor",
        anchorName: "Same Anchor",
        rate: String(randomInt(next, 1, 10_000)),
        sourceAmount: "100",
        destinationAmount: "100",
        fee: "0",
        capturedAt: new Date(NOW.getTime() - index * 1000),
      }),
    );

    const latest = selectLatestPerAnchor(history);
    assert.equal(latest.length, 1);

    const result = computeFreshMedian(
      latest.map((row) => ({
        anchorSlug: row.anchorSlug,
        corridorSlug: "usdc-us-brl-br",
        rate: row.rate,
        capturedAt: row.capturedAt,
      })),
      NOW,
    );

    assert.equal(result.state, "insufficient_fresh_sources");
    assert.equal(result.median, null);
    assert.equal(result.freshSourceCount, 1);
  }
});
