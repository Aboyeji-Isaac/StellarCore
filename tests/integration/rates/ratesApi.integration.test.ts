import assert from "node:assert/strict";
import test from "node:test";

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
    observation("zeam", "zeam-old", "9", 60_000),
    observation("zeam", "zeam-latest", "0.100000000000000001", 1_000),
    observation("anchor-b", "b-latest", "0.100000000000000002", 2_000),
  ];
  const repository: LatestRateRepository = {
    findCorridorBySlug: async (slug) => ({ id: "controlled-corridor", slug }),
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
  assert.equal(result.body.state, "healthy");
  assert.equal(result.body.medianRate, "0.1000000000000000015");
  assert.deepEqual(
    result.body.observations.map(({ rate }) => rate),
    ["0.100000000000000002", "0.100000000000000001"],
  );
});

function observation(
  anchorSlug: string,
  id: string,
  rate: string,
  ageMs: number,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - ageMs),
  });
}
