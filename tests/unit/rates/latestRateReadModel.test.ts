import assert from "node:assert/strict";
import test from "node:test";

import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import {
  readLatestCorridorRate,
  selectLatestPerAnchor,
} from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-08-27T12:00:00.000Z");
const CORRIDOR_RECORD = Object.freeze({
  id: "corridor-id",
  slug: CORRIDOR,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

test("missing corridor and empty history return safe typed states", async () => {
  assert.deepEqual(await readLatestCorridorRate("missing", {
    evaluatedAt: NOW,
    repository: repository([], false),
  }), { ok: false, corridorSlug: "missing", code: "CORRIDOR_NOT_FOUND" });

  const empty = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: repository([]),
  });
  assert.equal(empty.ok && empty.state, "insufficient_fresh_sources");
  assert.equal(empty.ok && empty.median, null);
  assert.equal(empty.ok && empty.totalObservationCount, 0);
  assert.equal(empty.ok && empty.freshObservationCount, 0);
  assert.equal(empty.ok && empty.independentAuthorityCount, 0);
  assert.equal(empty.ok && empty.freshIndependentSourceCount, 0);
});

test("one fresh anchor remains one independent authority and has no median", async () => {
  const result = await read([row("one", "snapshot-1", "1", ago(1_000))]);
  assert.equal(result.ok && result.totalObservationCount, 1);
  assert.equal(result.ok && result.freshObservationCount, 1);
  assert.equal(result.ok && result.independentAuthorityCount, 1);
  assert.equal(result.ok && result.freshIndependentSourceCount, 1);
  assert.equal(result.ok && result.median, null);
  assert.equal(result.ok && result.observations[0]?.anchorName, "One Persisted");
  assert.equal(result.ok && result.observations[0]?.authorityId, "auth-0001");
  assert.equal(result.ok && result.observations[0]?.authorityConfigurationVersion, 1);
  assert.deepEqual(result.ok && result.corridor, {
    slug: CORRIDOR,
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
  });
});

test("same-anchor history selects latest first and never falls back to an older row", async () => {
  const result = await read([
    row("same", "older-fresh", "10", ago(60_000)),
    row("same", "newer-future", "20", new Date(NOW.getTime() + 1)),
  ]);
  assert.equal(result.ok && result.totalObservationCount, 1);
  assert.equal(result.ok && result.observations[0]?.snapshotId, "newer-future");
  assert.equal(result.ok && result.freshIndependentSourceCount, 0);
  assert.equal(result.ok && result.observations[0]?.freshnessState, "future");
});

test("two and three independently reviewed authorities produce exact medians", async () => {
  const even = await read([
    row("a", "a1", "0.100000000000000001", ago(1), "auth-0001"),
    row("b", "b1", "0.100000000000000002", ago(2), "auth-0002"),
  ]);
  assert.equal(even.ok && even.independentAuthorityCount, 2);
  assert.equal(even.ok && even.median, "0.1000000000000000015");

  const odd = await read([
    row("a", "a1", "10", ago(1), "auth-0001"),
    row("b", "b1", "2", ago(2), "auth-0002"),
    row("c", "c1", "3", ago(3), "auth-0003"),
  ]);
  assert.equal(odd.ok && odd.median, "3");
});

test("two fresh anchors under one reviewed authority contribute one value", async () => {
  const result = await read([
    row("zeam", "zeam-1", "0.17", ago(1_000), "auth-0001"),
    row("zeam-partner", "partner-1", "0.18", ago(2_000), "auth-0001"),
  ]);

  assert.equal(result.ok && result.totalObservationCount, 2);
  assert.equal(result.ok && result.freshObservationCount, 2);
  assert.equal(result.ok && result.independentAuthorityCount, 1);
  assert.equal(result.ok && result.freshIndependentSourceCount, 1);
  assert.equal(result.ok && result.state, "insufficient_fresh_sources");
  assert.equal(result.ok && result.median, null);
  assert.equal(result.ok && result.exclusions.length, 1);
  assert.equal(result.ok && result.exclusions[0]?.exclusionReason, "correlated_same_authority");
  assert.equal(result.ok && result.exclusions[0]?.included, false);
});

test("the freshest correlated observation represents its authority deterministically", async () => {
  const result = await read([
    row("stale-sibling", "sibling-stale", "99", ago(120_001), "auth-0001"),
    row("fresh-sibling", "sibling-fresh", "0.19", ago(5_000), "auth-0001"),
  ]);

  const included = result.ok
    ? result.observations.filter(({ included }) => included)
    : [];
  assert.equal(included.length, 1);
  assert.equal(included[0]?.snapshotId, "sibling-fresh");
  assert.equal(result.ok && result.exclusions[0]?.snapshotId, "sibling-stale");
  assert.equal(result.ok && result.exclusions[0]?.exclusionReason, "correlated_same_authority");
});

test("legacy unknown-authority observations never count as independent", async () => {
  const result = await read([
    row("legacy-a", "legacy-a-1", "1", ago(1_000), null, null),
    row("legacy-b", "legacy-b-1", "2", ago(2_000), null, null),
  ]);

  assert.equal(result.ok && result.totalObservationCount, 2);
  assert.equal(result.ok && result.freshObservationCount, 2);
  assert.equal(result.ok && result.independentAuthorityCount, 0);
  assert.equal(result.ok && result.freshIndependentSourceCount, 0);
  assert.equal(result.ok && result.state, "insufficient_fresh_sources");
  assert.equal(result.ok && result.median, null);
  assert.deepEqual(
    result.ok && result.exclusions.map(({ exclusionReason }) => exclusionReason),
    ["unknown_authority", "unknown_authority"],
  );
});

test("a known authority and an unknown legacy row do not combine into a median", async () => {
  const result = await read([
    row("known", "known-1", "0.17", ago(1_000), "auth-0001"),
    row("legacy", "legacy-1", "9", ago(2_000), null, null),
  ]);

  assert.equal(result.ok && result.independentAuthorityCount, 1);
  assert.equal(result.ok && result.median, null);
  assert.deepEqual(
    result.ok && result.exclusions.map(({ exclusionReason }) => exclusionReason),
    ["unknown_authority"],
  );
});

test("freshness boundary is inclusive and greater ages are stale", async () => {
  const result = await read([
    row("boundary", "b1", "1", ago(RATE_FRESHNESS_THRESHOLD_MS), "auth-0001"),
    row("stale", "s1", "2", ago(RATE_FRESHNESS_THRESHOLD_MS + 1), "auth-0002"),
  ]);
  assert.equal(result.ok && result.observations[0]?.freshnessState, "fresh");
  assert.equal(result.ok && result.observations[1]?.freshnessState, "stale");
  assert.equal(result.ok && result.freshObservationCount, 1);
  assert.equal(result.ok && result.freshIndependentSourceCount, 1);
});

test("future, invalid-time, and invalid-rate observations are excluded safely", async () => {
  const result = await read([
    row("future", "f1", "1", new Date(NOW.getTime() + 1), "auth-0001"),
    row("invalid-rate", "r1", "1e3", ago(1), "auth-0002"),
    row("invalid-time", "t1", "1", "not-a-time", "auth-0003"),
  ]);
  assert.equal(result.ok && result.freshIndependentSourceCount, 0);
  assert.deepEqual(result.ok && result.exclusions.map(({ exclusionReason }) => exclusionReason), [
    "future_timestamp",
    "invalid_rate",
    "invalid_timestamp",
  ]);
});

test("identical capturedAt values use the greater stable snapshot id", () => {
  const selected = selectLatestPerAnchor([
    row("anchor", "00000000-0000-0000-0000-000000000001", "1", ago(1)),
    row("anchor", "00000000-0000-0000-0000-000000000002", "2", ago(1)),
  ]);
  assert.equal(selected[0]?.id, "00000000-0000-0000-0000-000000000002");
});

test("read results are deeply immutable at object and collection boundaries", async () => {
  const result = await read([row("a", "a1", "1", ago(1))]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.ok && Object.isFrozen(result.observations), true);
  assert.equal(result.ok && Object.isFrozen(result.observations[0]), true);
  assert.equal(result.ok && Object.isFrozen(result.exclusions), true);
});

test("repository failures and invalid evaluation times expose only safe codes", async () => {
  const failed = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: {
      findCorridorBySlug: async () => { throw new Error("DATABASE_URL=secret"); },
      findLatestObservations: async () => [],
    },
  });
  assert.deepEqual(failed, { ok: false, corridorSlug: CORRIDOR, code: "READ_FAILURE" });
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.deepEqual(await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: new Date("invalid"),
    repository: repository([]),
  }), { ok: false, corridorSlug: CORRIDOR, code: "INVALID_EVALUATION_TIME" });
});

async function read(history: readonly LatestRateRepositoryObservation[]) {
  return readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: repository(history),
  });
}

function repository(
  history: readonly LatestRateRepositoryObservation[],
  exists = true,
): LatestRateRepository {
  return {
    findCorridorBySlug: async () => exists ? CORRIDOR_RECORD : null,
    findLatestObservations: async () => history,
  };
}

function row(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date | string,
  authorityId: string | null = "auth-0001",
  authorityConfigurationVersion: number | null = authorityId === null ? null : 1,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug[0]!.toUpperCase()}${anchorSlug.slice(1)} Persisted`,
    authorityId,
    authorityConfigurationVersion,
    rate,
    sourceAmount: "100",
    destinationAmount: "10",
    fee: "0",
    capturedAt,
  });
}

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}
