import assert from "node:assert/strict";
import test from "node:test";

import { MIN_FRESH_SOURCES } from "@/constants/rates";
import { RATE_CAPTURE_MAX_INTERVAL_MS } from "@/constants/scheduling";
import { formatLiveRateRunSummary } from "@/lib/rates/liveRateSource";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { readCaptureCadenceHealth } from "@/lib/scheduled/cadenceHealthReadModel";
import {
  runReviewedRateCapture,
  type RateCaptureRunDependencies,
} from "@/lib/scheduled/captureRates";
import { createProcessCaptureLock } from "@/lib/scheduled/captureLock";
import type { CorridorRegistryEntry } from "@/types/corridor";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type { RateSnapshotRepository } from "@/types/rates";
import type { Sep38AssetIdentifier, Sep38IndicativePrice } from "@/types/sep38";
import type { CaptureRunCompletion, CaptureRunIdentity } from "@/types/scheduling";

const T0 = new Date("2026-09-28T12:00:00.000Z");
const OFFSET = (ms: number) => new Date(T0.getTime() + ms);

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

/**
 * One Zeam observation is the current reviewed production configuration. A
 * faster cadence produces more observations, never a second independent source.
 */
test("healthy, delayed, and missed capture cadences produce the correct fresh and stale states without synthetic observations", async () => {
  const world = createWorld();

  // --- A scheduled capture at T0 succeeds and persists one reviewed observation.
  const firstRun = await world.capture(T0);
  assert.equal(firstRun.state, "completed");
  assert.equal(firstRun.ok, true);
  assert.equal(world.stored().length, 1);
  assert.equal(world.stored()[0]!.captureRunId, firstRun.runId);

  // --- T0 + 30s: healthy cadence, fresh observation, still no median.
  const healthy = await world.observe(OFFSET(30_000));
  assert.equal(healthy.cadence.state, "healthy");
  assert.equal(healthy.cadence.signalScope, "stellarcore_capture_process");
  assert.equal(healthy.rate.ok, true);
  assert.equal(healthy.rate.ok && healthy.rate.observations[0]!.freshnessState, "fresh");
  assert.equal(healthy.rate.ok && healthy.rate.state, "insufficient_fresh_sources");
  assert.equal(healthy.rate.ok && healthy.rate.median, null);
  assert.equal(healthy.rate.ok && healthy.rate.freshSourceCount, 1);

  // --- T0 + 80s: delayed cadence, observation still fresh inside the shared
  //     threshold, and no relabelling or fabrication happens.
  const delayed = await world.observe(OFFSET(80_000));
  assert.equal(delayed.cadence.state, "delayed");
  assert.equal(delayed.cadence.missedIntervals, 1);
  assert.equal(delayed.rate.ok && delayed.rate.observations[0]!.freshnessState, "fresh");
  assert.equal(delayed.rate.ok && delayed.rate.median, null);
  assert.equal(world.stored().length, 1);

  // --- The scheduled run for the next tick never happens. At T0 + 150s the
  //     cadence is missed and the persisted evidence is stale; no observation
  //     is backfilled to cover the gap.
  const missed = await world.observe(OFFSET(150_000));
  assert.equal(missed.cadence.state, "missed");
  assert.equal(missed.cadence.missedIntervals, 2);
  assert.equal(missed.rate.ok && missed.rate.observations[0]!.freshnessState, "stale");
  assert.equal(missed.rate.ok && missed.rate.state, "insufficient_fresh_sources");
  assert.equal(missed.rate.ok && missed.rate.median, null);
  assert.equal(missed.rate.ok && missed.rate.exclusions.length, 1);
  assert.equal(world.stored().length, 1, "a missed run must not create an observation");
  assert.equal(world.captureInvocations, 1);

  // --- Recovery: the next scheduled capture runs, the cadence is healthy again,
  //     the newest observation is fresh, and the median is still null because
  //     capture frequency is not source independence.
  const recovered = await world.capture(OFFSET(150_000));
  assert.equal(recovered.state, "completed");
  assert.equal(world.stored().length, 2);

  const afterRecovery = await world.observe(OFFSET(150_000));
  assert.equal(afterRecovery.cadence.state, "healthy");
  assert.equal(afterRecovery.rate.ok && afterRecovery.rate.observations.length, 1);
  assert.equal(afterRecovery.rate.ok && afterRecovery.rate.observations[0]!.freshnessState, "fresh");
  assert.equal(afterRecovery.rate.ok && afterRecovery.rate.median, null);
  assert.equal(afterRecovery.rate.ok && afterRecovery.rate.freshSourceCount, 1);
  assert.equal(MIN_FRESH_SOURCES, 2);

  // The stale history is retained, not rewritten.
  assert.equal(new Date(world.stored()[0]!.capturedAt).toISOString(), T0.toISOString());
});

test("reading persisted evidence never triggers capture", async () => {
  const world = createWorld();
  await world.capture(T0);
  const before = world.captureInvocations;

  for (const ms of [0, 30_000, 90_000, 200_000]) {
    await world.observe(OFFSET(ms));
  }

  assert.equal(world.captureInvocations, before);
});

test("a delayed read never upgrades the cadence signal into evidence of anchor health", async () => {
  const world = createWorld();
  await world.capture(T0);

  const { cadence } = await world.observe(OFFSET(RATE_CAPTURE_MAX_INTERVAL_MS + 1));
  assert.equal(cadence.state, "missed");
  assert.deepEqual([...cadence.notEvidenceOf], [
    "anchor_reachability",
    "price_or_quote_availability",
    "transfer_execution_success",
    "rate_freshness_or_median_eligibility",
  ]);
  assert.equal(cadence.signalScope, "stellarcore_capture_process");
});

function createWorld() {
  const snapshots: Array<LatestRateRepositoryObservation & { captureRunId: string | null }> = [];
  const runs: CaptureRunCompletion[] = [];
  const identities: CaptureRunIdentity[] = [];
  let captureInvocations = 0;
  let clock = T0;

  const snapshotRepository: RateSnapshotRepository = Object.freeze({
    async findAnchorBySlug(slug) {
      return Object.freeze({ id: slug });
    },
    async findCorridorBySlug() {
      return Object.freeze({ id: "corridor-1" });
    },
    async hasAssociation() {
      return true;
    },
    async createSnapshot(input) {
      const observation = Object.freeze({
        id: `snapshot-${snapshots.length + 1}`,
        anchorSlug: input.anchorId,
        anchorName: "Zeam",
        rate: input.rate,
        sourceAmount: input.sourceAmount,
        destinationAmount: input.destinationAmount,
        fee: input.fee,
        capturedAt: input.capturedAt,
        captureRunId: input.captureRunId,
      });
      snapshots.push(observation);
      return observation;
    },
  });

  const latestRateRepository: LatestRateRepository = Object.freeze({
    async findCorridorBySlug() {
      return Object.freeze({
        id: "corridor-1",
        slug: CORRIDOR.slug,
        assetCodeFrom: CORRIDOR.assetCodeFrom,
        countryFrom: CORRIDOR.countryFrom,
        assetCodeTo: CORRIDOR.assetCodeTo,
        countryTo: CORRIDOR.countryTo,
      });
    },
    async findLatestObservations() {
      return Object.freeze([...snapshots]);
    },
  });

  const dependencies: RateCaptureRunDependencies = Object.freeze({
    capture: async ({ lineage }) => {
      captureInvocations += 1;
      return formatLiveRateRunSummary(await runRateEngine([{
        anchorSlug: "zeam",
        corridor: CORRIDOR,
        request: Object.freeze({
          sellAsset: SELL_ASSET,
          buyAsset: BUY_ASSET,
          sellAmount: "100",
          context: "sep31" as const,
        }),
      }], {
        quote: async () => QUOTE,
        repository: snapshotRepository,
        lineage,
        now: () => clock,
      }));
    },
    lock: createProcessCaptureLock(),
    lineage: Object.freeze({
      async startRun(input: CaptureRunIdentity) {
        identities.push(input);
      },
      async completeRun(input: CaptureRunCompletion) {
        runs.push(input);
      },
      async findLatestCompletedScheduledRun() {
        const latest = runs[runs.length - 1];
        if (!latest) return null;
        return Object.freeze({
          runId: latest.runId,
          completedAt: latest.completedAt,
          scheduledIntervalMs: 60_000,
          outcome: latest.outcome,
        });
      },
    }),
    scheduler: () => "external" as const,
    auditSchedule: () => Object.freeze({
      ok: true,
      contract: Object.freeze({
        version: 1,
        freshnessThresholdMs: 120_000,
        executionBudgetMs: 20_000,
        jitterAllowanceMs: 10_000,
        executionHeadroomMs: 30_000,
        maxIntervalMs: RATE_CAPTURE_MAX_INTERVAL_MS,
      }),
      selectedScheduler: "external" as const,
      intervalMs: 60_000,
      issues: Object.freeze([]),
    }),
    configurationFingerprint: () => "fingerprint",
    now: () => clock,
  });

  return {
    dependencies,
    get captureInvocations() { return captureInvocations; },
    stored: () => snapshots,
    identities,
    capture: async (startedAt: Date) => {
      clock = startedAt;
      return runReviewedRateCapture(dependencies);
    },
    observe: async (now: Date) => {
      clock = now;
      const cadence = await readCaptureCadenceHealth({
        lineage: dependencies.lineage,
        auditSchedule: dependencies.auditSchedule,
        now: () => now,
      });
      const rate = await readLatestCorridorRate(CORRIDOR.slug, {
        repository: latestRateRepository,
        evaluatedAt: now,
      });
      return { cadence, rate };
    },
  };
}
