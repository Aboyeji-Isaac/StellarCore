import assert from "node:assert/strict";
import test from "node:test";

import { runRateEngine } from "@/lib/rates/rateEngine";
import { persistRateSnapshot } from "@/lib/rates/snapshot";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type {
  PersistedRateSnapshot,
  RateCandidate,
  RateSnapshotRepository,
} from "@/types/rates";
import type { Sep38AssetIdentifier, Sep38IndicativePrice } from "@/types/sep38";

const CAPTURED_AT = new Date("2026-08-31T16:00:00.000Z");

const CORRIDOR: CorridorRegistryEntry = Object.freeze({
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

const SELL_ASSET: Sep38AssetIdentifier =
  "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const BUY_ASSET: Sep38AssetIdentifier = "iso4217:BRL";

const QUOTE: Sep38IndicativePrice = Object.freeze({
  sellAsset: SELL_ASSET,
  buyAsset: BUY_ASSET,
  totalPrice: "0.18",
  price: "0.17",
  sellAmount: "100",
  buyAmount: "17",
  fee: { total: "1", asset: BUY_ASSET, details: [] },
});

test("a persisted observation carries the capture-run identity it was captured under", async () => {
  const repository = recordingRepository();
  const result = await persistRateSnapshot(
    Object.freeze({
      anchorSlug: "zeam",
      corridorSlug: CORRIDOR.slug,
      rate: "0.17",
      sourceAmount: "100",
      destinationAmount: "17",
      fee: "1",
      capturedAt: CAPTURED_AT,
    }),
    repository,
    Object.freeze({ captureRunId: "run-1" }),
  );

  assert.equal(result.ok, true);
  assert.equal(repository.created.length, 1);
  assert.equal(repository.created[0]!.captureRunId, "run-1");
  if (result.ok) assert.equal(result.snapshot.captureRunId, "run-1");
});

test("lineage is optional only for manual operator snapshots, never invented", async () => {
  const repository = recordingRepository();
  await persistRateSnapshot(
    Object.freeze({
      anchorSlug: "zeam",
      corridorSlug: CORRIDOR.slug,
      rate: "0.17",
      sourceAmount: "100",
      destinationAmount: "17",
      fee: "1",
      capturedAt: CAPTURED_AT,
    }),
    repository,
  );

  assert.equal(repository.created[0]!.captureRunId, null);
});

test("a persistence failure writes no snapshot and therefore no lineage link", async () => {
  const repository = recordingRepository({ association: false });
  const result = await persistRateSnapshot(
    Object.freeze({
      anchorSlug: "zeam",
      corridorSlug: CORRIDOR.slug,
      rate: "0.17",
      sourceAmount: "100",
      destinationAmount: "17",
      fee: "1",
      capturedAt: CAPTURED_AT,
    }),
    repository,
    Object.freeze({ captureRunId: "run-1" }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(repository.created, []);
});

test("every observation written by one engine run is linked to that run", async () => {
  const repository = recordingRepository();
  const result = await runRateEngine([candidate("zeam"), candidate("other")], {
    quote: async () => QUOTE,
    repository,
    lineage: Object.freeze({ captureRunId: "run-42" }),
    now: () => CAPTURED_AT,
  });

  assert.equal(result.succeeded, 2);
  assert.deepEqual(repository.created.map(({ captureRunId }) => captureRunId), ["run-42", "run-42"]);
  assert.deepEqual(result.snapshots.map(({ captureRunId }) => captureRunId), ["run-42", "run-42"]);
});

test("a failed source writes no snapshot while a successful source stays committed", async () => {
  const repository = recordingRepository();
  let call = 0;
  const result = await runRateEngine([candidate("zeam"), candidate("broken")], {
    quote: async () => {
      call += 1;
      if (call === 2) throw new Error("network down");
      return QUOTE;
    },
    repository,
    lineage: Object.freeze({ captureRunId: "run-42" }),
    now: () => CAPTURED_AT,
  });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(repository.created.length, 1);
  assert.equal(repository.created[0]!.anchorId, "zeam");
  assert.deepEqual(result.failures.map(({ code }) => code), ["QUOTE_FAILURE"]);
});

test("an exhausted execution budget skips remaining sources instead of failing or fabricating them", async () => {
  const repository = recordingRepository();
  let attempts = 0;
  const result = await runRateEngine([candidate("zeam"), candidate("other")], {
    quote: async () => {
      attempts += 1;
      return QUOTE;
    },
    repository,
    lineage: Object.freeze({ captureRunId: "run-42" }),
    now: () => CAPTURED_AT,
    shouldContinue: () => attempts === 0,
  });

  assert.equal(attempts, 1);
  assert.equal(result.totalAttempted, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.skippedSources, [{
    anchorSlug: "other",
    corridorSlug: CORRIDOR.slug,
    reason: "EXECUTION_BUDGET_EXHAUSTED",
  }]);
  assert.equal(repository.created.length, 1);
});

function candidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: CORRIDOR,
    request: Object.freeze({
      sellAsset: SELL_ASSET,
      buyAsset: BUY_ASSET,
      sellAmount: "100",
      context: "sep31" as const,
    }),
  });
}

function recordingRepository(
  options: { association?: boolean } = {},
): RateSnapshotRepository & { created: Array<{ anchorId: string; captureRunId: string | null }> } {
  const created: Array<{ anchorId: string; captureRunId: string | null }> = [];
  return {
    created,
    async findAnchorBySlug(slug) {
      return Object.freeze({ id: slug });
    },
    async findCorridorBySlug() {
      return Object.freeze({ id: "corridor-1" });
    },
    async hasAssociation() {
      return options.association ?? true;
    },
    async createSnapshot(input) {
      created.push(Object.freeze({ anchorId: input.anchorId, captureRunId: input.captureRunId }));
      const snapshot: PersistedRateSnapshot = Object.freeze({
        id: `snapshot-${created.length}`,
        anchorSlug: input.anchorId,
        corridorSlug: CORRIDOR.slug,
        rate: input.rate,
        sourceAmount: input.sourceAmount,
        destinationAmount: input.destinationAmount,
        fee: input.fee,
        capturedAt: input.capturedAt,
        captureRunId: input.captureRunId,
      });
      return snapshot;
    },
  };
}
