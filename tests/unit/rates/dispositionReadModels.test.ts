import assert from "node:assert/strict";
import test from "node:test";

import { serializeRates } from "@/lib/api/rates";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { readRateObservationTimeline, type TimelineRow } from "@/lib/rates/observationTimeline";
import type { LatestRateRepositoryObservation } from "@/types/latestRates";

const EVALUATED_AT = new Date("2026-09-29T12:00:00.000Z");
const CORRIDOR = Object.freeze({
  id: "corridor-id",
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

function observation(
  id: string,
  anchorSlug: string,
  secondsAgo: number,
  disposition: LatestRateRepositoryObservation["disposition"] = null,
): LatestRateRepositoryObservation {
  return {
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate: "5.1",
    sourceAmount: "100",
    destinationAmount: "510",
    fee: "0",
    capturedAt: new Date(EVALUATED_AT.getTime() - secondsAgo * 1_000),
    disposition,
  };
}

const INVALIDATED = Object.freeze({
  state: "invalidated" as const,
  reasonCode: "SOURCE_COMPROMISED",
  recordedAt: "2026-09-29T11:59:00.000Z",
});

test("an invalidated newest observation is excluded and no older row is promoted", async () => {
  const result = await readLatestCorridorRate("usdc-us-brl-br", {
    evaluatedAt: EVALUATED_AT,
    repository: {
      findCorridorBySlug: async () => CORRIDOR,
      findLatestObservations: async () => [
        observation("a-newest", "anchor-a", 10, INVALIDATED),
        // Present only to prove it is never chosen in place of the newest.
        observation("a-older", "anchor-a", 30),
        observation("b", "anchor-b", 20),
        observation("c", "anchor-c", 20),
        observation("d", "anchor-d", 20),
      ],
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const anchorA = result.observations.filter(({ anchorSlug }) => anchorSlug === "anchor-a");
  assert.equal(anchorA.length, 1);
  assert.equal(anchorA[0]!.snapshotId, "a-newest");
  assert.equal(anchorA[0]!.included, false);
  assert.equal(anchorA[0]!.exclusionReason, "invalidated");
  assert.equal(anchorA[0]!.freshnessState, "fresh", "freshness stays truthful to the capture time");
  assert.deepEqual(anchorA[0]!.disposition, INVALIDATED);
  assert.equal(result.freshSourceCount, 3);
  assert.equal(result.exclusions.length, 1);

  const body = serializeRates(result);
  const publicA = body.observations.find(({ anchor }) => anchor.slug === "anchor-a")!;
  assert.equal(publicA.eligibleForMedian, false);
  assert.equal(publicA.exclusionReason, "invalidated");
  assert.deepEqual(publicA.disposition, INVALIDATED);
  const text = JSON.stringify(body);
  for (const internal of ["reviewReference", "actor", "note", "a-newest", "a-older"]) {
    assert.equal(text.includes(internal), false, `public payload exposes ${internal}`);
  }
});

test("a disposition takes precedence over freshness and can empty the median", async () => {
  const result = await readLatestCorridorRate("usdc-us-brl-br", {
    evaluatedAt: EVALUATED_AT,
    repository: {
      findCorridorBySlug: async () => CORRIDOR,
      findLatestObservations: async () => [
        observation("a", "anchor-a", 600, { ...INVALIDATED, state: "quarantined", reasonCode: "SUSPECTED_INCORRECT_VALUE" }),
        observation("b", "anchor-b", 10, { ...INVALIDATED, state: "superseded", reasonCode: "NORMALIZATION_DEFECT" }),
        observation("c", "anchor-c", 10),
      ],
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
  assert.deepEqual(
    result.observations.map(({ anchorSlug, exclusionReason }) => [anchorSlug, exclusionReason]),
    [["anchor-a", "quarantined"], ["anchor-b", "superseded"], ["anchor-c", undefined]],
  );
});

test("legacy observations without dispositions are unchanged and not marked reviewed", async () => {
  const result = await readLatestCorridorRate("usdc-us-brl-br", {
    evaluatedAt: EVALUATED_AT,
    repository: {
      findCorridorBySlug: async () => CORRIDOR,
      findLatestObservations: async () => [observation("a", "anchor-a", 10)],
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal("disposition" in result.observations[0]!, false);
  assert.equal("disposition" in serializeRates(result).observations[0]!, false);
});

test("the timeline keeps every stored point, flags blocked ones, and never interpolates", async () => {
  const rows: TimelineRow[] = [
    timelineRow("p1", "2026-09-01T00:00:00.000Z"),
    timelineRow("p2", "2026-09-02T00:00:00.000Z", "INVALIDATE", "SEMANTICALLY_INCORRECT"),
    timelineRow("p3", "2026-09-05T00:00:00.000Z", "RELEASE", "REVIEW_CLEARED"),
  ];
  const timeline = await readRateObservationTimeline("usdc-us-brl-br", {
    from: new Date("2026-09-01T00:00:00.000Z"),
    to: new Date("2026-09-10T00:00:00.000Z"),
  }, {
    findCorridorBySlug: async () => CORRIDOR,
    findObservations: async () => rows,
  });

  assert.equal(timeline.ok, true);
  if (!timeline.ok) return;
  assert.deepEqual(timeline.points.map(({ snapshotId, usable }) => [snapshotId, usable]), [
    ["p1", true],
    ["p2", false],
    ["p3", true],
  ]);
  assert.equal(timeline.points[1]!.disposition?.state, "invalidated");
  assert.equal(timeline.points[1]!.rate, "5.1", "the original value is preserved, not rewritten");
  assert.equal(timeline.truncated, false);
});

test("the timeline rejects unbounded or inverted ranges", async () => {
  const repository = {
    findCorridorBySlug: async () => CORRIDOR,
    findObservations: async () => [],
  };
  for (const [from, to] of [
    ["2026-09-10", "2026-09-01"],
    ["2025-01-01", "2026-09-01"],
    ["invalid", "2026-09-01"],
  ]) {
    assert.deepEqual(
      await readRateObservationTimeline("x", { from: new Date(from!), to: new Date(to!) }, repository),
      { ok: false, code: "INVALID_RANGE" },
    );
  }
});

function timelineRow(
  id: string,
  capturedAt: string,
  action: string | null = null,
  reason: string | null = null,
): TimelineRow {
  return {
    id,
    anchorSlug: "anchor-a",
    rate: "5.1",
    capturedAt: new Date(capturedAt),
    dispositionAction: action,
    dispositionReason: reason,
    dispositionRecordedAt: action ? new Date("2026-09-20T00:00:00.000Z") : null,
  };
}
