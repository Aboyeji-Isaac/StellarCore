import assert from "node:assert/strict";
import test from "node:test";

import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";

import {
  snapshotReviewedLiveRates,
  type SnapshotReviewedLiveRatesDependencies,
} from "@/lib/rates/snapshotRun";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

test("failed configuration audit short-circuits before live candidate preparation", async () => {
  let buildCalls = 0;
  let executeCalls = 0;
  const dependencies: SnapshotReviewedLiveRatesDependencies = {
    assertConfiguration: () => {
      throw new Error("safe configuration failure");
    },
    buildCandidates: async () => {
      buildCalls += 1;
      return [];
    },
    executeCandidates: async () => {
      executeCalls += 1;
      return summary();
    },
  };

  await assert.rejects(snapshotReviewedLiveRates(dependencies), /safe configuration failure/);
  assert.equal(buildCalls, 0);
  assert.equal(executeCalls, 0);
});

test("valid configuration preserves reviewed snapshot execution flow", async () => {
  const events: string[] = [];
  const expected = summary();
  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () => events.push("audit"),
    buildCandidates: async () => {
      events.push("prepare");
      return [];
    },
    executeCandidates: async (candidates) => {
      events.push(`execute:${candidates.length}`);
      return expected;
    },
  });

  assert.deepEqual(events, ["audit", "prepare", "execute:0"]);
  assert.equal(result, expected);
});

test("anomaly assessment runs after persistence for each corridor that received snapshots", async () => {
  const events: string[] = [];
  const anomalyAssessment = Object.freeze({
    corridorsAssessed: 1,
    assessmentsAppended: 2,
    quarantined: Object.freeze([]),
    failures: Object.freeze([]),
  });
  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () => undefined,
    buildCandidates: async () => [],
    executeCandidates: async () => {
      events.push("execute");
      return Object.freeze({
        ...summary(),
        snapshots: Object.freeze([
          { id: "s1", anchorSlug: "a", corridorSlug: "usdc-us-brl-br", rate: "1", capturedAt: "2026-09-30T00:00:00.000Z" },
        ]),
      });
    },
    assessAnomalies: async (corridorSlugs) => {
      events.push(`assess:${corridorSlugs.join(",")}`);
      return anomalyAssessment;
    },
  });

  assert.deepEqual(events, ["execute", "assess:usdc-us-brl-br"]);
  assert.equal(result.anomalyAssessment, anomalyAssessment);
});

test("anomaly assessment is skipped when no snapshot was persisted", async () => {
  let assessed = false;
  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () => undefined,
    buildCandidates: async () => [],
    executeCandidates: async () => summary(),
    assessAnomalies: async () => {
      assessed = true;
      throw new Error("must not run");
    },
  });
  assert.equal(assessed, false);
  assert.equal(result.anomalyAssessment, undefined);
});

function summary(): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 0,
    totalAttempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 0,
    snapshots: Object.freeze([]),
    failures: Object.freeze([]),
    skippedSources: Object.freeze([]),
  });
}


test("durably suppressed sources are removed before candidate preparation", async () => {
  const first = REVIEWED_LIVE_RATE_SOURCES[0];
  assert.ok(first);

  let preparedSourceKeys: string[] = [];
  let executed = -1;

  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () => {},
    listSuppressed: async () => [{
      anchorSlug: first.anchorSlug,
      corridorSlug: first.corridorSlug,
    }],
    buildCandidates: async (sources = []) => {
      preparedSourceKeys = sources.map(
        ({ anchorSlug, corridorSlug }) => `${anchorSlug}:${corridorSlug}`,
      );
      return [];
    },
    executeCandidates: async (candidates) => {
      executed = candidates.length;
      return summary();
    },
  });

  assert.equal(
    preparedSourceKeys.includes(`${first.anchorSlug}:${first.corridorSlug}`),
    false,
  );
  assert.equal(executed, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(result.succeeded, 0);
});
