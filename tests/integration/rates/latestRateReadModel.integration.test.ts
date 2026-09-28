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
    observation("anchor-a", "a-old", "100", 60_000, "auth-0001"),
    observation("anchor-a", "a-latest", "1600", 1_000, "auth-0001"),
    observation("anchor-b", "b-latest", "1610", 2_000, "auth-0002"),
    observation("anchor-c", "c-stale", "9999", 120_001, "auth-0003"),
  ];
  const repository: LatestRateRepository = {
    findCorridorBySlug: async (slug) => ({
      id: "corridor-id",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "NGN",
      countryTo: "NG",
    }),
    findLatestObservations: async () => history,
  };

  const result = await readLatestCorridorRate("usdc-us-ngn-ng", {
    repository,
    evaluatedAt: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.totalObservationCount, 3);
  assert.equal(result.ok && result.freshObservationCount, 2);
  assert.equal(result.ok && result.independentAuthorityCount, 3);
  assert.equal(result.ok && result.freshIndependentSourceCount, 2);
  assert.equal(result.ok && result.median, "1605");
  assert.deepEqual(result.ok && result.observations.map(({ snapshotId }) => snapshotId), [
    "a-latest",
    "b-latest",
    "c-stale",
  ]);
  assert.equal(result.ok && result.exclusions[0]?.anchorSlug, "anchor-c");
});

test("two fresh anchors under one authority compose to one independent value", async () => {
  const repository: LatestRateRepository = {
    findCorridorBySlug: async (slug) => ({
      id: "corridor-id",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    findLatestObservations: async () => [
      observation("zeam", "zeam-latest", "0.17", 1_000, "auth-0001"),
      observation("zeam-partner", "partner-latest", "0.18", 2_000, "auth-0001"),
    ],
  };

  const result = await readLatestCorridorRate("usdc-us-brl-br", {
    repository,
    evaluatedAt: NOW,
  });

  assert.equal(result.ok && result.totalObservationCount, 2);
  assert.equal(result.ok && result.freshObservationCount, 2);
  assert.equal(result.ok && result.independentAuthorityCount, 1);
  assert.equal(result.ok && result.freshIndependentSourceCount, 1);
  assert.equal(result.ok && result.state, "insufficient_fresh_sources");
  assert.equal(result.ok && result.median, null);
  assert.deepEqual(
    result.ok && result.exclusions.map(({ exclusionReason }) => exclusionReason),
    ["correlated_same_authority"],
  );
});

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  ageMs: number,
  authorityId: string | null = "auth-0001",
): LatestRateRepositoryObservation {
  return {
    id,
    anchorSlug,
    anchorName: `${anchorSlug} persisted`,
    authorityId,
    authorityConfigurationVersion: authorityId === null ? null : 1,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - ageMs),
  };
}
