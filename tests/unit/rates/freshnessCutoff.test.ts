import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FRESH_SOURCES,
  RATE_FRESHNESS_THRESHOLD_MS,
} from "@/constants/rates";
import { computeFreshMedian } from "@/lib/rates/median";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type { MedianSource } from "@/types/rates";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";
const CUTOFF = RATE_FRESHNESS_THRESHOLD_MS;

const CORRIDOR_RECORD = Object.freeze({
  id: "corridor-id",
  slug: CORRIDOR,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

test("observations exactly at the freshness cutoff are aggregated", () => {
  for (const boundary of [
    new Date(NOW.getTime() - CUTOFF),
    new Date(NOW.getTime() - CUTOFF).toISOString(),
  ]) {
    const result = computeFreshMedian([
      source("inside", "1", ago(1)),
      source("boundary", "3", boundary),
    ], NOW);

    assert.equal(result.state, "healthy");
    assert.equal(result.median, "2");
    assert.equal(result.freshSourceCount, 2);
    assert.deepEqual(result.sources.map(({ included }) => included), [true, true]);
    assert.deepEqual(
      result.sources.map(({ exclusionReason }) => exclusionReason),
      [undefined, undefined],
    );
  }
});

test("observations one millisecond past the cutoff are excluded from the aggregate", () => {
  const result = computeFreshMedian([
    source("inside", "1", ago(1)),
    source("boundary", "3", ago(CUTOFF)),
    source("just-stale", "1000", ago(CUTOFF + 1)),
  ], NOW);

  assert.equal(result.state, "healthy");
  // Including the stale observation would produce the three-value median 3.
  assert.equal(result.median, "2");
  assert.equal(result.freshSourceCount, 2);
  assert.deepEqual(result.sources.map(({ included }) => included), [true, true, false]);
  assert.equal(result.sources[2]?.exclusionReason, "stale");
});

test("the cutoff boundary alone decides whether an extreme observation joins the median", () => {
  const inside = [
    source("low", "10", ago(1)),
    source("high", "20", ago(2)),
  ];
  const atCutoff = computeFreshMedian(
    [...inside, source("boundary", "1000", ago(CUTOFF))],
    NOW,
  );
  const pastCutoff = computeFreshMedian(
    [...inside, source("boundary", "1000", ago(CUTOFF + 1))],
    NOW,
  );

  assert.equal(atCutoff.state, "healthy");
  assert.equal(atCutoff.median, "20");
  assert.equal(atCutoff.freshSourceCount, 3);

  assert.equal(pastCutoff.state, "healthy");
  assert.equal(pastCutoff.median, "15");
  assert.equal(pastCutoff.freshSourceCount, 2);
});

test("insufficient fresh evidence reports null instead of falling back to old observations", () => {
  const staleOnly = computeFreshMedian([
    source("stale-a", "10", ago(CUTOFF + 1)),
    source("stale-b", "20", ago(CUTOFF + 60_000)),
  ], NOW);
  const oneFresh = computeFreshMedian([
    source("fresh", "10", ago(1)),
    source("stale", "20", ago(CUTOFF + 1)),
  ], NOW);
  const unusable = computeFreshMedian([
    source("future", "10", new Date(NOW.getTime() + 1)),
    source("invalid-time", "20", "not-a-time"),
    source("zero-rate", "0", ago(1)),
  ], NOW);

  for (const result of [staleOnly, oneFresh, unusable]) {
    assert.equal(result.state, "insufficient_fresh_sources");
    assert.equal(result.median, null);
  }

  assert.equal(staleOnly.freshSourceCount, 0);
  assert.deepEqual(
    staleOnly.sources.map(({ exclusionReason }) => exclusionReason),
    ["stale", "stale"],
  );

  assert.equal(oneFresh.freshSourceCount, 1);
  assert.ok(oneFresh.freshSourceCount < MIN_FRESH_SOURCES);
  assert.deepEqual(
    oneFresh.sources.map(({ included }) => included),
    [true, false],
  );

  assert.equal(unusable.freshSourceCount, 0);
  assert.deepEqual(
    unusable.sources.map(({ exclusionReason }) => exclusionReason),
    ["future_timestamp", "invalid_timestamp", "invalid_rate"],
  );
});

test("cutoff selection is deterministic and independent of input order", () => {
  const build = (): readonly MedianSource[] => [
    source("inside-a", "2", ago(1)),
    source("boundary", "8", ago(CUTOFF)),
    source("stale", "1000", ago(CUTOFF + 1)),
    source("future", "1000", new Date(NOW.getTime() + 1)),
  ];

  const first = computeFreshMedian(build(), NOW);
  const second = computeFreshMedian(build(), NOW);
  const reversed = computeFreshMedian([...build()].reverse(), NOW);

  assert.deepEqual(first, second);
  assert.equal(first.state, "healthy");
  assert.equal(first.median, "5");
  assert.equal(first.freshSourceCount, 2);

  assert.equal(reversed.state, first.state);
  assert.equal(reversed.median, first.median);
  assert.equal(reversed.freshSourceCount, first.freshSourceCount);
  assert.deepEqual(
    Object.fromEntries(reversed.sources.map(({ anchorSlug, included, exclusionReason }) =>
      [anchorSlug, { included, exclusionReason }])),
    Object.fromEntries(first.sources.map(({ anchorSlug, included, exclusionReason }) =>
      [anchorSlug, { included, exclusionReason }])),
  );
});

test("latest-rate aggregation applies the same cutoff to the published median", async () => {
  const result = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: repository([
      row("inside", "inside-1", "1", ago(1)),
      row("boundary", "boundary-1", "3", ago(CUTOFF)),
      row("stale", "stale-1", "1000", ago(CUTOFF + 1)),
    ]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "healthy");
  assert.equal(result.median, "2");
  assert.equal(result.totalIndependentSources, 3);
  assert.equal(result.freshSourceCount, 2);
  assert.deepEqual(
    result.observations.map(({ anchorSlug, freshnessState, included }) =>
      ({ anchorSlug, freshnessState, included })),
    [
      { anchorSlug: "boundary", freshnessState: "fresh", included: true },
      { anchorSlug: "inside", freshnessState: "fresh", included: true },
      { anchorSlug: "stale", freshnessState: "stale", included: false },
    ],
  );
  assert.deepEqual(
    result.exclusions.map(({ anchorSlug, exclusionReason }) =>
      ({ anchorSlug, exclusionReason })),
    [{ anchorSlug: "stale", exclusionReason: "stale" }],
  );
});

test("latest-rate aggregation with a single boundary observation stays insufficient", async () => {
  const result = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: repository([
      row("boundary", "boundary-1", "1", ago(CUTOFF)),
      row("stale", "stale-1", "1000", ago(CUTOFF + 1)),
    ]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
  assert.equal(result.freshSourceCount, 1);
  assert.deepEqual(
    result.exclusions.map(({ anchorSlug, exclusionReason }) =>
      ({ anchorSlug, exclusionReason })),
    [{ anchorSlug: "stale", exclusionReason: "stale" }],
  );
});

function source(
  anchorSlug: string,
  rate: string,
  capturedAt: Date | string,
): MedianSource {
  return Object.freeze({
    anchorSlug,
    corridorSlug: CORRIDOR,
    rate,
    capturedAt,
  });
}

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

function repository(
  history: readonly LatestRateRepositoryObservation[],
): LatestRateRepository {
  return {
    findCorridorBySlug: async () => CORRIDOR_RECORD,
    findLatestObservations: async () => history,
  };
}

function row(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date | string,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: anchorSlug[0]!.toUpperCase() + anchorSlug.slice(1),
    rate,
    sourceAmount: "100",
    destinationAmount: "10",
    fee: "0",
    capturedAt,
  });
}
