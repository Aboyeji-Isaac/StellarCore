import assert from "node:assert/strict";
import test from "node:test";

import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import { getRateFreshness } from "@/lib/rates/freshness";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { runRateEngine } from "@/lib/rates/rateEngine";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type {
  RateCandidate,
  RateSnapshotRepository,
} from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USD = "iso4217:USD" as const;
const CORRIDOR = "usdc-us-usd-us";

const T0 = new Date("2026-08-27T12:00:00.000Z");
// T1 is 2 hours later, past the 15-minute freshness threshold
const T1 = new Date(T0.getTime() + 2 * 60 * 60 * 1000);

function createCandidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: Object.freeze({
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
    }),
    request: Object.freeze({
      sellAsset: USDC,
      buyAsset: USD,
      sellAmount: "100",
      context: "sep31",
    }),
  });
}

function createQuote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1",
    price: "1",
    sellAmount: "100",
    buyAmount: "100",
    fee: Object.freeze({ total: "0", asset: USD, details: Object.freeze([]) }),
    ...overrides,
  });
}

class InMemoryRateStore implements RateSnapshotRepository, LatestRateRepository {
  public records: LatestRateRepositoryObservation[] = [];
  private idCounter = 0;

  async findAnchorBySlug(slug: string) {
    return { id: `anchor-${slug}` };
  }

  async findCorridorBySlug(slug: string) {
    return {
      id: "corridor-id",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
    };
  }

  async hasAssociation(_anchorId: string, _corridorId: string) {
    return true;
  }

  async createSnapshot(input: {
    anchorId: string;
    corridorId: string;
    rate: string;
    sourceAmount: string;
    destinationAmount: string;
    fee: string;
    capturedAt: Date;
  }) {
    this.idCounter += 1;
    const anchorSlug = input.anchorId.replace("anchor-", "");
    const observation: LatestRateRepositoryObservation = Object.freeze({
      id: `snapshot-${this.idCounter}`,
      anchorSlug,
      anchorName: `${anchorSlug} Persisted`,
      rate: input.rate,
      sourceAmount: input.sourceAmount,
      destinationAmount: input.destinationAmount,
      fee: input.fee,
      capturedAt: new Date(input.capturedAt.getTime()),
    });
    this.records.push(observation);
    return {
      id: observation.id,
      ...input,
    };
  }

  async findLatestObservations(corridorId: string) {
    if (corridorId !== "corridor-id") return [];
    return [...this.records];
  }
}

test("capture failure before validation boundary (network/quote failure) does not advance freshness timestamp", async () => {
  const store = new InMemoryRateStore();

  // 1. Initial valid capture at T0
  const initialRun = await runRateEngine([createCandidate("anchor-a")], {
    quote: async () => createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" }),
    repository: store,
    now: () => T0,
  });
  assert.equal(initialRun.succeeded, 1);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0]?.capturedAt.getTime(), T0.getTime());

  // At T0, the observation is fresh
  const freshnessAtT0 = getRateFreshness(store.records[0]!.capturedAt, T0);
  assert.equal(freshnessAtT0.state, "fresh");
  assert.equal(freshnessAtT0.ageMs, 0);

  // 2. Later at T1, a quote capture attempt fails before validation boundary
  const failedRun = await runRateEngine([createCandidate("anchor-a")], {
    quote: async () => {
      throw new Error("HTTP 503 Upstream Service Unavailable");
    },
    repository: store,
    now: () => T1,
  });
  assert.equal(failedRun.succeeded, 0);
  assert.equal(failedRun.failed, 1);
  assert.equal(failedRun.failures[0]?.phase, "QUOTE");
  assert.equal(failedRun.failures[0]?.code, "QUOTE_FAILURE");

  // Repository must not have been modified or updated with a new snapshot or timestamp
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0]?.capturedAt.getTime(), T0.getTime());

  // Freshness evaluated at T1 must reflect the age since T0 (now stale), NOT refreshed to T1
  const freshnessAtT1 = getRateFreshness(store.records[0]!.capturedAt, T1);
  assert.equal(freshnessAtT1.state, "stale");
  assert.equal(freshnessAtT1.ageMs, T1.getTime() - T0.getTime());

  // In the read model at T1, the observation is identified as stale and not falsely marked fresh
  const readResult = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: T1,
    repository: store,
  });
  assert.equal(readResult.ok, true);
  if (readResult.ok) {
    assert.equal(readResult.freshSourceCount, 0);
    assert.equal(readResult.observations[0]?.freshnessState, "stale");
    assert.equal(new Date(readResult.observations[0]!.capturedAt).getTime(), T0.getTime());
  }
});

test("capture failure during normalization (validation boundary) preserves prior timestamp and freshness", async () => {
  const store = new InMemoryRateStore();

  // Seed baseline observation at T0
  await runRateEngine([createCandidate("anchor-a")], {
    quote: async () => createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" }),
    repository: store,
    now: () => T0,
  });
  assert.equal(store.records.length, 1);

  // Test various invalid quotes that fail normalization at T1
  const malformedQuotes = [
    { price: "0", totalPrice: "0", expectedCode: "INVALID_RATE" },
    { price: "-1.5", totalPrice: "-1.5", expectedCode: "INVALID_RATE" },
    { price: "not-a-number", totalPrice: "not-a-number", expectedCode: "INVALID_RATE" },
  ];

  for (const { price, totalPrice, expectedCode } of malformedQuotes) {
    const invalidRun = await runRateEngine([createCandidate("anchor-a")], {
      quote: async () => createQuote({ price, totalPrice }),
      repository: store,
      now: () => T1,
    });

    assert.equal(invalidRun.succeeded, 0);
    assert.equal(invalidRun.failed, 1);
    assert.equal(invalidRun.failures[0]?.phase, "NORMALIZATION");
    assert.equal(invalidRun.failures[0]?.code, expectedCode);

    // Repository continues to hold only the initial snapshot with T0 timestamp
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0]?.capturedAt.getTime(), T0.getTime());
  }

  // Evaluated at T1, freshness state is stale based strictly on original T0
  const freshness = getRateFreshness(store.records[0]!.capturedAt, T1);
  assert.equal(freshness.state, "stale");
});

test("capture failure at persistence boundary does not advance freshness state", async () => {
  const store = new InMemoryRateStore();

  // Baseline at T0
  await runRateEngine([createCandidate("anchor-a")], {
    quote: async () => createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" }),
    repository: store,
    now: () => T0,
  });

  // At T1, simulate database persistence failure
  const failingStore: RateSnapshotRepository = {
    findAnchorBySlug: async (slug) => store.findAnchorBySlug(slug),
    findCorridorBySlug: async (slug) => store.findCorridorBySlug(slug),
    hasAssociation: async (a, c) => store.hasAssociation(a, c),
    createSnapshot: async () => {
      throw new Error("Database connection timed out during INSERT");
    },
  };

  const persistenceFailRun = await runRateEngine([createCandidate("anchor-a")], {
    quote: async () => createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" }),
    repository: failingStore,
    now: () => T1,
  });

  assert.equal(persistenceFailRun.succeeded, 0);
  assert.equal(persistenceFailRun.failed, 1);
  assert.equal(persistenceFailRun.failures[0]?.phase, "PERSISTENCE");
  assert.equal(persistenceFailRun.failures[0]?.code, "PERSISTENCE_FAILURE");

  // Existing store remains at T0
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0]?.capturedAt.getTime(), T0.getTime());
  assert.equal(store.records[0]?.rate, "1");

  // Read model confirms freshness is not advanced
  const readResult = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: T1,
    repository: store,
  });
  assert.equal(readResult.ok, true);
  if (readResult.ok) {
    assert.equal(readResult.observations[0]?.rate, "1");
    assert.equal(readResult.observations[0]?.freshnessState, "stale");
  }
});

test("partial success across multiple sources preserves independent freshness timestamps", async () => {
  const store = new InMemoryRateStore();

  // Initial captures for two sources at T0
  await runRateEngine([createCandidate("anchor-healthy"), createCandidate("anchor-failing")], {
    quote: async () => createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" }),
    repository: store,
    now: () => T0,
  });
  assert.equal(store.records.length, 2);

  // At T1: anchor-healthy succeeds, anchor-failing fails at quote phase
  const partialRun = await runRateEngine(
    [createCandidate("anchor-healthy"), createCandidate("anchor-failing")],
    {
      quote: async (cand) => {
        if (cand.anchorSlug === "anchor-failing") {
          throw new Error("Gateway timeout");
        }
        return createQuote({ price: "1", totalPrice: "1", sellAmount: "100", buyAmount: "100" });
      },
      repository: store,
      now: () => T1,
    },
  );

  assert.equal(partialRun.succeeded, 1);
  assert.equal(partialRun.failed, 1);
  assert.equal(partialRun.failures[0]?.anchorSlug, "anchor-failing");

  // Store now has 3 records: 2 from T0, 1 from T1 (healthy only)
  assert.equal(store.records.length, 3);

  const readResult = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: T1,
    repository: store,
  });
  assert.equal(readResult.ok, true);
  if (readResult.ok) {
    assert.equal(readResult.totalIndependentSources, 2);
    // anchor-healthy is fresh at T1
    const healthyObs = readResult.observations.find((o) => o.anchorSlug === "anchor-healthy");
    assert.ok(healthyObs);
    assert.equal(new Date(healthyObs.capturedAt).getTime(), T1.getTime());
    assert.equal(healthyObs.freshnessState, "fresh");
    assert.equal(healthyObs.rate, "1");

    // anchor-failing was NOT advanced and remains at T0 (stale at T1)
    const failingObs = readResult.observations.find((o) => o.anchorSlug === "anchor-failing");
    assert.ok(failingObs);
    assert.equal(new Date(failingObs.capturedAt).getTime(), T0.getTime());
    assert.equal(failingObs.freshnessState, "stale");
    assert.equal(failingObs.rate, "1");

    // Only 1 fresh source exists
    assert.equal(readResult.freshSourceCount, 1);
  }
});

test("elapsed time verifies freshness decays monotonically without being reset by failed attempts", () => {
  const originalCapturedAt = T0;

  // Immediately at T0: age is 0 ms, fresh
  const initialFreshness = getRateFreshness(originalCapturedAt, T0);
  assert.equal(initialFreshness.state, "fresh");
  assert.equal(initialFreshness.ageMs, 0);

  // At threshold limit (15 min): still fresh
  const atThresholdTime = new Date(T0.getTime() + RATE_FRESHNESS_THRESHOLD_MS);
  const atThresholdFreshness = getRateFreshness(originalCapturedAt, atThresholdTime);
  assert.equal(atThresholdFreshness.state, "fresh");
  assert.equal(atThresholdFreshness.ageMs, RATE_FRESHNESS_THRESHOLD_MS);

  // 1ms past threshold: becomes stale
  const pastThresholdTime = new Date(T0.getTime() + RATE_FRESHNESS_THRESHOLD_MS + 1);
  const pastThresholdFreshness = getRateFreshness(originalCapturedAt, pastThresholdTime);
  assert.equal(pastThresholdFreshness.state, "stale");
  assert.equal(pastThresholdFreshness.ageMs, RATE_FRESHNESS_THRESHOLD_MS + 1);

  // An attempt occurring at pastThresholdTime that fails produces NO new timestamp;
  // evaluating with the original timestamp at pastThresholdTime remains strictly stale.
  const failedAttemptTime = pastThresholdTime;
  // If an erroneous system had used failedAttemptTime as capturedAt, it would falsely report "fresh":
  const erroneousFreshness = getRateFreshness(failedAttemptTime, failedAttemptTime);
  assert.equal(erroneousFreshness.state, "fresh"); // proves the bug would have occurred

  // But using the legitimate preserved persisted timestamp guarantees it remains stale:
  const verifiedFreshness = getRateFreshness(originalCapturedAt, failedAttemptTime);
  assert.equal(verifiedFreshness.state, "stale");
  assert.equal(verifiedFreshness.ageMs, RATE_FRESHNESS_THRESHOLD_MS + 1);
});
