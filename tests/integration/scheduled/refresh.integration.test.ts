import assert from "node:assert/strict";
import test from "node:test";

import { runReputationEvaluation } from "@/lib/scheduled/refresh";

const EVALUATED_AT = new Date("2026-08-31T17:00:00.000Z");

test("controlled reputation integration passes exactly one persisted evaluation time to evidence reads", async () => {
  const events: string[] = [];
  const result = await runReputationEvaluation({
    evaluateReputation: async ({ evaluatedAt }) => {
      events.push(`reputation:${evaluatedAt.toISOString()}`);
      return { attempted: 2, succeeded: 2, failed: 0, failures: [] };
    },
    now: () => EVALUATED_AT,
  });

  assert.deepEqual(events, ["reputation:2026-08-31T17:00:00.000Z"]);
  assert.equal(result.ok, true);
  assert.equal(result.job, "reputation-evaluation");
  assert.equal(result.reputation.succeeded, 2);
  assert.equal(result.startedAt, EVALUATED_AT.toISOString());
  assert.equal(result.completedAt, EVALUATED_AT.toISOString());
});
