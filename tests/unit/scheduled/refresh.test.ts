import assert from "node:assert/strict";
import test from "node:test";

import {
  runReputationEvaluation,
  type ReputationEvaluationDependencies,
} from "@/lib/scheduled/refresh";

const STARTED_AT = new Date("2026-08-31T16:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-31T16:00:01.000Z");

test("reputation evaluation reads persisted evidence at one run timestamp and returns a bounded result", async () => {
  const observedAt: string[] = [];
  const result = await runReputationEvaluation(dependencies({
    evaluateReputation: async ({ evaluatedAt }) => {
      observedAt.push(evaluatedAt.toISOString());
      return reputationSummary();
    },
  }));

  assert.deepEqual(observedAt, [STARTED_AT.toISOString()]);
  assert.deepEqual(result, {
    job: "reputation-evaluation",
    ok: true,
    startedAt: STARTED_AT.toISOString(),
    completedAt: COMPLETED_AT.toISOString(),
    reputation: { attempted: 3, succeeded: 3, failed: 0, failures: [] },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("the reputation job never captures a rate and holds no capture authority", async () => {
  // The dependency surface is the whole contract: only an evidence evaluation
  // callback and a clock. There is no capture, quote, or persistence seam.
  const keys = Object.keys(dependencies({})).sort();
  assert.deepEqual(keys, ["evaluateReputation", "now"]);
});

test("partial anchor evidence failures are reported without fabricating a score", async () => {
  const result = await runReputationEvaluation(dependencies({
    evaluateReputation: async () => reputationSummary({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      failures: [{ anchorSlug: "moneygram", code: "EVIDENCE_READ_FAILURE" }],
    }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.reputation.succeeded, 2);
  assert.deepEqual(result.reputation.failures, [
    { anchorSlug: "moneygram", code: "EVIDENCE_READ_FAILURE" },
  ]);
});

test("a fatal evaluation failure reaches the HTTP boundary rather than being misreported as a score", async () => {
  await assert.rejects(
    runReputationEvaluation(dependencies({
      evaluateReputation: async () => {
        throw new Error("database unavailable");
      },
    })),
  );
});

test("sequential reputation invocations remain independent", async () => {
  let runs = 0;
  const deps = dependencies({
    evaluateReputation: async () => {
      runs += 1;
      return reputationSummary();
    },
  });

  await runReputationEvaluation(deps);
  await runReputationEvaluation(deps);
  assert.equal(runs, 2);
});

function dependencies(
  overrides: Partial<ReputationEvaluationDependencies>,
): ReputationEvaluationDependencies {
  let clockCalls = 0;
  return Object.freeze({
    evaluateReputation: async () => reputationSummary(),
    now: () => (clockCalls++ % 2 === 0 ? STARTED_AT : COMPLETED_AT),
    ...overrides,
  });
}

function reputationSummary(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    attempted: 3,
    succeeded: 3,
    failed: 0,
    failures: [],
    ...overrides,
  }) as Awaited<ReturnType<ReputationEvaluationDependencies["evaluateReputation"]>>;
}
