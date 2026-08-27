import assert from "node:assert/strict";
import test from "node:test";

import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";

const NOW = new Date("2026-08-27T12:00:00.000Z");

test("controlled history composes latest-per-anchor, freshness, and median offline", async () => {
  const history: readonly LatestRateRepositoryObservation[] = [
    observation("anchor-a", "a-old", "100", 60_000),
    observation("anchor-a", "a-latest", "1600", 1_000),
    observation("anchor-b", "b-latest", "1610", 2_000),
    observation("anchor-c", "c-stale", "9999", 120_001),
  ];
  const repository: LatestRateRepository = {
    findCorridorBySlug: async (slug) => ({ id: "corridor-id", slug }),
    findLatestObservations: async () => history,
  };

  const result = await readLatestCorridorRate("usdc-us-ngn-ng", {
    repository,
    evaluatedAt: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.totalIndependentSources, 3);
  assert.equal(result.ok && result.freshSourceCount, 2);
  assert.equal(result.ok && result.median, "1605");
  assert.deepEqual(result.ok && result.observations.map(({ snapshotId }) => snapshotId), [
    "a-latest",
    "b-latest",
    "c-stale",
  ]);
  assert.equal(result.ok && result.exclusions[0]?.anchorSlug, "anchor-c");
});

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  ageMs: number,
): LatestRateRepositoryObservation {
  return {
    id,
    anchorSlug,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - ageMs),
  };
}
