import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunDependencies,
} from "@/lib/reputation/run";
import type { ClockIntegrityVerdict } from "@/types/clock";

const EVALUATED_AT = new Date("2026-08-31T15:00:00.000Z");

const TEST_SNAPSHOT = Object.freeze({
  snapshotId: "100:5:",
  readAt: EVALUATED_AT,
  isolationLevel: "REPEATABLE READ" as const,
});

test("persisted reputation evaluation is deterministic, deduplicated, and isolates engine failures", async () => {
  const calls: string[] = [];
  const dependencies: ReputationEvaluationRunDependencies = Object.freeze({
    ...baseDependencies(),
    listAnchorSlugs: async () => ["zeam", "cowrie", "zeam", "moneygram"],
    evaluate: async (slug, options) => {
      calls.push(`${slug}:${options.evaluatedAt.toISOString()}`);
      return slug === "moneygram"
        ? Object.freeze({ ok: false as const, anchorSlug: slug, code: "PERSISTENCE_FAILURE" as const })
        : Object.freeze({
          ok: true as const,
          calculation: {} as never,
          persisted: null,
          snapshot: TEST_SNAPSHOT,
        });
    },
  });

  const result = await evaluatePersistedAnchorReputations({
    evaluatedAt: EVALUATED_AT,
    dependencies,
  });

  assert.deepEqual(calls, [
    "cowrie:2026-08-31T15:00:00.000Z",
    "moneygram:2026-08-31T15:00:00.000Z",
    "zeam:2026-08-31T15:00:00.000Z",
  ]);
  assert.deepEqual(result, {
    attempted: 3,
    succeeded: 2,
    failed: 1,
    failures: [{ anchorSlug: "moneygram", code: "PERSISTENCE_FAILURE" }],
    clockIntegrity: null,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.failures), true);
});

test("explicit anchor slugs preserve the shared evaluation path without listing anchors", async () => {
  let listed = false;
  const result = await evaluatePersistedAnchorReputations({
    anchorSlugs: ["zeam"],
    evaluatedAt: EVALUATED_AT,
    dependencies: Object.freeze({
      ...baseDependencies(),
      listAnchorSlugs: async () => {
        listed = true;
        return [];
      },
      evaluate: async () => Object.freeze({
        ok: true as const,
        calculation: {} as never,
        persisted: null,
        snapshot: TEST_SNAPSHOT,
      }),
    }),
  });

  assert.equal(listed, false);
  assert.deepEqual(result, {
    attempted: 1,
    succeeded: 1,
    failed: 0,
    failures: [],
    clockIntegrity: null,
  });
});

test("a rejected clock-integrity gate stops evaluation before listing or scoring anchors", async () => {
  let listed = false;
  const rejected: ClockIntegrityVerdict = Object.freeze({
    boundary: "REPUTATION_EVALUATION",
    outcome: "REJECTED",
    code: "CLOCK_SKEW_EXCEEDED",
    direction: "NEGATIVE",
    skewMs: -30_000,
    toleranceMs: 5_000,
    applicationTime: "2026-08-31T14:59:30.000Z",
    databaseTime: "2026-08-31T15:00:00.000Z",
    runId: null,
  });

  const result = await evaluatePersistedAnchorReputations({
    dependencies: Object.freeze({
      ...baseDependencies(),
      listAnchorSlugs: async () => {
        listed = true;
        return ["zeam"];
      },
      checkClockIntegrity: async () => rejected,
    }),
  });

  assert.equal(listed, false);
  assert.equal(result.attempted, 0);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{ code: "CLOCK_SKEW_EXCEEDED" }]);
  assert.equal(result.clockIntegrity, rejected);
});
