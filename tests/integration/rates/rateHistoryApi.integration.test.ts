import assert from "node:assert/strict";
import test from "node:test";

import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { readCorridorRateHistory } from "@/lib/rates/rateHistoryReadModel";
import type {
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";

test("Rate history API integration computes sequence of medians and handles gaps honestly", async () => {
  const day1 = new Date(NOW.getTime() - 10 * 86_400_000);
  const day5 = new Date(NOW.getTime() - 5 * 86_400_000);
  const day5Plus50ms = new Date(day5.getTime() + 50);

  const history: readonly RateHistoryRepositoryObservation[] = [
    // Day 1: 2 anchors -> healthy median
    observation("anchor-a", "a1", "5.10", day1),
    observation("anchor-b", "b1", "5.20", day1),
    // Day 5 (5 day gap from day 1): 2 anchors -> healthy median
    observation("anchor-a", "a2", "5.30", day5),
    observation("anchor-b", "b2", "5.40", day5Plus50ms),
  ];

  const repository: RateHistoryRepository = {
    findCorridorBySlug: async (slug) => ({
      id: "corridor-id",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    findHistoryObservations: async () => history,
  };

  const result = await getRateHistoryApiResult(CORRIDOR, "30", {
    now: () => NOW,
    readHistory: (slug, { evaluatedAt, days }) =>
      readCorridorRateHistory(slug, { repository, evaluatedAt, days }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;

  assert.equal(result.body.windowDays, 30);
  assert.equal(result.body.points.length, 2);

  // Point 1
  const p1 = result.body.points[0]!;
  assert.equal(p1.medianRate, "5.15");
  assert.equal(p1.state, "healthy");
  assert.equal(p1.sourceCount, 2);
  assert.equal(p1.observations.length, 2);

  // Point 2
  const p2 = result.body.points[1]!;
  assert.equal(p2.medianRate, "5.35");
  assert.equal(p2.state, "healthy");
  assert.equal(p2.sourceCount, 2);
  assert.equal(p2.observations.length, 2);

  // Gaps check: difference between point 1 and point 2 is 5 days + 50ms
  const p1Time = new Date(p1.timestamp).getTime();
  const p2Time = new Date(p2.timestamp).getTime();
  assert.equal(p2Time - p1Time, 5 * 86_400_000 + 50);
});

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date,
): RateHistoryRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug} Persisted`,
    rate,
    sourceAmount: "100",
    destinationAmount: rate,
    fee: "0",
    capturedAt,
  });
}
