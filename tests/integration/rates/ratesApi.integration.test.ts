import assert from "node:assert/strict";
import test from "node:test";

import { MIN_FRESH_SOURCES } from "@/constants/rates";
import { getRatesApiResult } from "@/lib/api/rates";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";

test("API composition preserves latest-per-anchor selection and exact median offline", async () => {
  const history: readonly LatestRateRepositoryObservation[] = [
    observation("zeam", "zeam-old", "9", 60_000, "auth-0001"),
    observation("zeam", "zeam-latest", "0.100000000000000001", 1_000, "auth-0001"),
    observation("anchor-b", "b-latest", "0.100000000000000002", 2_000, "auth-0002"),
  ];
  const repository: LatestRateRepository = {
    findCorridorBySlug: async (slug) => ({
      id: "controlled-corridor",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    findLatestObservations: async () => history,
  };

  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: (slug, { evaluatedAt }) =>
      readLatestCorridorRate(slug, { repository, evaluatedAt }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.sourceCount, 2);
  assert.equal(result.body.freshSourceCount, 2);
  assert.equal(result.body.totalObservationCount, 2);
  assert.equal(result.body.freshObservationCount, 2);
  assert.equal(result.body.independentAuthorityCount, 2);
  assert.equal(result.body.state, "healthy");
  assert.equal(result.body.medianRate, "0.1000000000000000015");
  assert.deepEqual(result.body.reviewedCandidateConfiguration, {
    candidateCount: 1,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
  assert.equal(
    result.body.medianRequirement.minimumFreshIndependentSources,
    MIN_FRESH_SOURCES,
  );
  assert.deepEqual(
    result.body.observations.map(({ rate }) => rate),
    ["0.100000000000000002", "0.100000000000000001"],
  );
  assert.deepEqual(
    result.body.observations.map(({ anchor }) => anchor.name),
    ["Anchor B Persisted", "Zeam Persisted"],
  );
});

test("persisted non-registry identity serializes independently from reviewed configuration", async () => {
  const corridorSlug = "persisted-usdc-aa-fiat-bb";
  const repository: LatestRateRepository = {
    findCorridorBySlug: async () => ({
      id: "persisted-corridor-id",
      slug: corridorSlug,
      assetCodeFrom: "PERSISTED",
      countryFrom: "AA",
      assetCodeTo: "FIAT",
      countryTo: "BB",
    }),
    findLatestObservations: async () => [
      observation(
        "persisted-anchor",
        "persisted-snapshot",
        "1.25",
        1_000,
        "auth-0042",
        "Persisted Anchor",
      ),
    ],
  };

  const result = await getRatesApiResult(corridorSlug, {
    now: () => NOW,
    readLatestRate: (slug, { evaluatedAt }) =>
      readLatestCorridorRate(slug, { repository, evaluatedAt }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.corridor, {
    slug: corridorSlug,
    sourceAsset: "PERSISTED",
    sourceCountry: "AA",
    destinationAsset: "FIAT",
    destinationCountry: "BB",
  });
  assert.deepEqual(result.body.observations[0]?.anchor, {
    slug: "persisted-anchor",
    name: "Persisted Anchor",
  });
  assert.equal(result.body.sourceCount, 1);
  assert.equal(result.body.freshSourceCount, 1);
  assert.equal(result.body.independentAuthorityCount, 1);
  assert.equal(result.body.medianRate, null);
  assert.deepEqual(result.body.observations[0]?.authority, {
    id: "auth-0042",
    displayName: null,
    configurationVersion: 1,
  });
  assert.deepEqual(result.body.reviewedCandidateConfiguration, {
    candidateCount: 0,
    uniqueAnchorCount: 0,
    uniqueAuthorityCount: 0,
  });
});

test("commonly controlled anchors stay one independent source through the API", async () => {
  const repository: LatestRateRepository = {
    findCorridorBySlug: async () => ({
      id: "shared-authority-corridor",
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    findLatestObservations: async () => [
      observation("zeam", "zeam-snapshot", "0.17", 1_000, "auth-0001"),
      observation("zeam-partner", "partner-snapshot", "0.18", 2_000, "auth-0001"),
    ],
  };

  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: (slug, { evaluatedAt }) =>
      readLatestCorridorRate(slug, { repository, evaluatedAt }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.equal(result.body.totalObservationCount, 2);
  assert.equal(result.body.freshObservationCount, 2);
  assert.equal(result.body.independentAuthorityCount, 1);
  assert.equal(result.body.freshSourceCount, 1);
  assert.equal(result.body.sourceCount, 2);
  assert.equal(
    result.body.observations.filter(({ eligibleForMedian }) => eligibleForMedian).length,
    1,
  );
  assert.equal(
    result.body.observations.find(({ eligibleForMedian }) => !eligibleForMedian)?.exclusionReason,
    "correlated_same_authority",
  );
});

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  ageMs: number,
  authorityId: string | null = "auth-0001",
  anchorName = `${anchorSlug[0]!.toUpperCase()}${anchorSlug.slice(1).replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`)} Persisted`,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName,
    authorityId,
    authorityConfigurationVersion: authorityId === null ? null : 1,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - ageMs),
  });
}
