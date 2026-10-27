import assert from "node:assert/strict";
import test from "node:test";

import {
  groupObservationsIntoSlices,
  readCorridorRateHistory,
} from "@/lib/rates/rateHistoryReadModel";
import type {
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-08-28T12:00:00.000Z");
const CORRIDOR_RECORD = Object.freeze({
  id: "corridor-id",
  slug: CORRIDOR,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

test("missing corridor and invalid options return safe typed error states", async () => {
  assert.deepEqual(
    await readCorridorRateHistory("missing", {
      evaluatedAt: NOW,
      repository: repository([], false),
    }),
    { ok: false, corridorSlug: "missing", code: "CORRIDOR_NOT_FOUND" },
  );

  assert.deepEqual(
    await readCorridorRateHistory(CORRIDOR, {
      evaluatedAt: new Date("invalid"),
      repository: repository([]),
    }),
    { ok: false, corridorSlug: CORRIDOR, code: "INVALID_EVALUATION_TIME" },
  );

  assert.deepEqual(
    await readCorridorRateHistory(CORRIDOR, {
      evaluatedAt: NOW,
      days: -5,
      repository: repository([]),
    }),
    { ok: false, corridorSlug: CORRIDOR, code: "INVALID_WINDOW" },
  );
});

test("empty history produces a valid response with empty points", async () => {
  const result = await readCorridorRateHistory(CORRIDOR, {
    evaluatedAt: NOW,
    days: 30,
    repository: repository([]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.points.length, 0);
  assert.equal(result.windowDays, 30);
  assert.equal(result.evaluatedAt, NOW.toISOString());
  assert.deepEqual(result.corridor, {
    slug: CORRIDOR,
    sourceAsset: "USDC",
    sourceCountry: "US",
    destinationAsset: "BRL",
    destinationCountry: "BR",
  });
});

test("single anchor snapshot produces a point with insufficient fresh sources", async () => {
  const t1 = ago(10_000);
  const result = await read([row("anchor-a", "s1", "5.25", t1)]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.points.length, 1);
  const point = result.points[0]!;
  assert.equal(point.sourceCount, 1);
  assert.equal(point.freshSourceCount, 1);
  assert.equal(point.state, "insufficient_fresh_sources");
  assert.equal(point.medianRate, null);
  assert.equal(point.observations.length, 1);
  assert.equal(point.observations[0]?.anchorSlug, "anchor-a");
  assert.equal(point.observations[0]?.rate, "5.25");
});

test("multiple anchors in the same slice compute an exact median", async () => {
  const t1 = ago(5000);
  const t2 = ago(4900); // 100ms later, within the 60s slice window
  const result = await read([
    row("anchor-a", "s1", "0.100000000000000001", t1),
    row("anchor-b", "s2", "0.100000000000000002", t2),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.points.length, 1);
  const point = result.points[0]!;
  assert.equal(point.state, "healthy");
  assert.equal(point.sourceCount, 2);
  assert.equal(point.freshSourceCount, 2);
  assert.equal(point.medianRate, "0.1000000000000000015");
});

test("observations separated by more than 60s produce separate chronological points", async () => {
  const tDay1 = ago(2 * 86_400_000);
  const tDay2 = ago(1 * 86_400_000);

  const result = await read([
    row("anchor-a", "s1", "5.10", tDay1),
    row("anchor-b", "s2", "5.20", tDay1),
    row("anchor-a", "s3", "5.30", tDay2),
    row("anchor-b", "s4", "5.40", tDay2),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0]?.medianRate, "5.15");
  assert.equal(result.points[1]?.medianRate, "5.35");
  assert.equal(result.points[0]?.timestamp, tDay1.toISOString());
  assert.equal(result.points[1]?.timestamp, tDay2.toISOString());
});

test("duplicate anchor observations in the same slice select the latest", () => {
  const t1 = ago(5000);
  const t2 = ago(4000);
  const slices = groupObservationsIntoSlices([
    row("anchor-a", "s1", "5.10", t1),
    row("anchor-a", "s2", "5.15", t2),
  ]);

  assert.equal(slices.length, 1);
  assert.equal(slices[0]?.length, 2);
});

test("repository failures return safe error codes and mask secrets", async () => {
  const failed = await readCorridorRateHistory(CORRIDOR, {
    evaluatedAt: NOW,
    repository: {
      findCorridorBySlug: async () => {
        throw new Error("DATABASE_URL=postgres://secret@localhost:5432");
      },
      findHistoryObservations: async () => [],
    },
  });

  assert.deepEqual(failed, {
    ok: false,
    corridorSlug: CORRIDOR,
    code: "READ_FAILURE",
  });
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("read results are deeply frozen", async () => {
  const result = await read([
    row("anchor-a", "s1", "1", ago(1000)),
    row("anchor-b", "s2", "2", ago(1000)),
  ]);

  assert.equal(Object.isFrozen(result), true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.corridor), true);
  assert.equal(Object.isFrozen(result.points), true);
  assert.equal(Object.isFrozen(result.points[0]), true);
  assert.equal(Object.isFrozen(result.points[0]?.observations), true);
  assert.equal(Object.isFrozen(result.points[0]?.observations[0]), true);
});

async function read(history: readonly RateHistoryRepositoryObservation[]) {
  return readCorridorRateHistory(CORRIDOR, {
    evaluatedAt: NOW,
    days: 30,
    repository: repository(history),
  });
}

function repository(
  history: readonly RateHistoryRepositoryObservation[],
  exists = true,
): RateHistoryRepository {
  return {
    findCorridorBySlug: async () => (exists ? CORRIDOR_RECORD : null),
    findHistoryObservations: async () => history,
  };
}

function row(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date | string,
): RateHistoryRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug[0]!.toUpperCase()}${anchorSlug.slice(1)} Persisted`,
    rate,
    sourceAmount: "100",
    destinationAmount: rate,
    fee: "0",
    capturedAt,
  });
}

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}
