/**
 * Stable tie-breaker regression tests for ordered rate reads (Issue #348).
 *
 * Persisted rate observations frequently share a `capturedAt` timestamp because
 * a single refresh cycle writes every anchor observation at the same instant.
 * Both ordered read paths therefore need a deterministic secondary key:
 *
 * - `latestObservationsQuery` selects the newest row per anchor with
 *   `ORDER BY captured_at DESC, id DESC`.
 * - `rateHistoryQuery` returns history with
 *   `ORDER BY captured_at ASC, id ASC`.
 *
 * These tests pin those tie-breakers, prove the read model re-derives the same
 * winner regardless of the order rows arrive in, and show that a snapshot
 * inserted between two reads with an identical timestamp resolves
 * deterministically instead of repeating or dropping a record.
 *
 * Consistency limits for concurrent inserts: the public directory APIs page by
 * `limit`/`offset` over an unordered-by-write-time key (slug), and the read
 * models have no snapshot isolation. An insert that sorts before the current
 * offset can therefore shift a later page, exactly as the existing contract
 * documents. These tests assert the ordering guarantees that do hold, not
 * snapshot isolation, and never introduce one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { latestObservationsQuery } from "@/lib/rates/latestRateRepository";
import { rateHistoryQuery } from "@/lib/rates/rateHistoryRepository";
import { readCorridorRateHistory } from "@/lib/rates/rateHistoryReadModel";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { selectLatestPerAnchor } from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type {
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";

const TIED_AT = "2026-09-20T12:00:00.000Z";
const EVALUATED_AT = new Date("2026-09-20T12:05:00.000Z");
const CORRIDOR = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
} as const;

function observation(
  id: string,
  anchorSlug: string,
  capturedAt: string,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate: "1.25",
    sourceAmount: "100",
    destinationAmount: "125",
    fee: "0",
    capturedAt,
  });
}

function latestRepository(
  observations: readonly LatestRateRepositoryObservation[],
): LatestRateRepository {
  return Object.freeze({
    findCorridorBySlug: async () => CORRIDOR,
    findLatestObservations: async () => observations,
  });
}

test("the latest-observation query orders equal capture times by descending snapshot id", () => {
  const sql = latestObservationsQuery(CORRIDOR.id).sql;
  assert.match(sql, /ORDER BY snapshot\.captured_at DESC, snapshot\.id DESC/);
});

test("the rate-history query orders equal capture times by ascending snapshot id", () => {
  const sql = rateHistoryQuery(
    CORRIDOR.id,
    new Date("2026-09-01T00:00:00.000Z"),
    new Date("2026-09-30T00:00:00.000Z"),
  ).sql;
  assert.match(sql, /ORDER BY snapshot\.captured_at ASC, snapshot\.id ASC/);
});

test("equal primary sort values resolve to the greatest snapshot id regardless of arrival order", () => {
  const rows = [
    observation("a-2", "alpha", TIED_AT),
    observation("a-1", "alpha", TIED_AT),
    observation("a-3", "alpha", TIED_AT),
  ];

  const expected = "a-3";
  for (const permutation of [
    [rows[0]!, rows[1]!, rows[2]!],
    [rows[2]!, rows[1]!, rows[0]!],
    [rows[1]!, rows[2]!, rows[0]!],
    [rows[2]!, rows[0]!, rows[1]!],
  ]) {
    const selected = selectLatestPerAnchor(permutation);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.id, expected);
  }
});

test("a tied snapshot inserted between reads becomes the deterministic latest without repeating anchors", async () => {
  const firstRead = await readLatestCorridorRate(CORRIDOR.slug, {
    repository: latestRepository([
      observation("alpha-1", "alpha", TIED_AT),
      observation("beta-1", "beta", TIED_AT),
    ]),
    evaluatedAt: EVALUATED_AT,
  });

  // An intervening refresh writes one more alpha snapshot with the same
  // timestamp but a lexicographically greater id.
  const secondRead = await readLatestCorridorRate(CORRIDOR.slug, {
    repository: latestRepository([
      observation("alpha-1", "alpha", TIED_AT),
      observation("alpha-2", "alpha", TIED_AT),
      observation("beta-1", "beta", TIED_AT),
    ]),
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(firstRead.ok, true);
  assert.equal(secondRead.ok, true);
  if (!firstRead.ok || !secondRead.ok) return;

  assert.deepEqual(firstRead.observations.map((row) => row.snapshotId), ["alpha-1", "beta-1"]);
  assert.deepEqual(secondRead.observations.map((row) => row.snapshotId), ["alpha-2", "beta-1"]);

  // One row per anchor in both reads: a tied insert cannot duplicate a record.
  for (const read of [firstRead, secondRead]) {
    const slugs = read.observations.map((row) => row.anchorSlug);
    assert.equal(new Set(slugs).size, slugs.length);
  }
});

test("history traversal keeps tied rows in id order and does not repeat them when a newer tied row is inserted", async () => {
  const historyRow = (
    id: string,
    anchorSlug: string,
    capturedAt: string,
  ): RateHistoryRepositoryObservation => Object.freeze({
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate: "1.25",
    sourceAmount: "100",
    destinationAmount: "125",
    fee: "0",
    capturedAt,
  });

  const repository = (
    rows: readonly RateHistoryRepositoryObservation[],
  ): RateHistoryRepository => Object.freeze({
    findCorridorBySlug: async () => CORRIDOR,
    // The real repository returns rows already ordered by
    // `captured_at ASC, id ASC`; the compiler here mirrors that contract.
    findHistoryObservations: async () => rows,
  });

  const pageOne = await readCorridorRateHistory(CORRIDOR.slug, {
    repository: repository([
      historyRow("r-1", "alpha", TIED_AT),
      historyRow("r-2", "alpha", TIED_AT),
    ]),
    evaluatedAt: EVALUATED_AT,
    days: 30,
  });

  const pageTwo = await readCorridorRateHistory(CORRIDOR.slug, {
    repository: repository([
      historyRow("r-1", "alpha", TIED_AT),
      historyRow("r-2", "alpha", TIED_AT),
      historyRow("r-3", "beta", TIED_AT),
    ]),
    evaluatedAt: EVALUATED_AT,
    days: 30,
  });

  assert.equal(pageOne.ok, true);
  assert.equal(pageTwo.ok, true);
  if (!pageOne.ok || !pageTwo.ok) return;

  // Tied rows are grouped into one slice, so the first request already saw the
  // whole tie group and the second request cannot re-emit it as a separate page.
  assert.equal(pageOne.points.length, 1);
  assert.equal(pageTwo.points.length, 1);
  assert.deepEqual(
    pageOne.points[0]?.observations.map((row) => row.anchorSlug),
    ["alpha"],
  );
  assert.deepEqual(
    pageTwo.points[0]?.observations.map((row) => row.anchorSlug),
    ["alpha", "beta"],
  );
});
