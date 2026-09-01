import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunDependencies,
} from "@/lib/reputation/run";

const EVALUATED_AT = new Date("2026-08-31T15:00:00.000Z");

test("persisted reputation evaluation is deterministic, deduplicated, and isolates engine failures", async () => {
  const calls: string[] = [];
  const dependencies: ReputationEvaluationRunDependencies = Object.freeze({
    listAnchorSlugs: async () => ["zeam", "cowrie", "zeam", "moneygram"],
    evaluate: async (slug, options) => {
      calls.push(`${slug}:${options.evaluatedAt.toISOString()}`);
      return slug === "moneygram"
        ? Object.freeze({ ok: false as const, anchorSlug: slug, code: "PERSISTENCE_FAILURE" as const })
        : Object.freeze({
          ok: true as const,
          calculation: {} as never,
          persisted: null,
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
      listAnchorSlugs: async () => {
        listed = true;
        return [];
      },
      evaluate: async () => Object.freeze({
        ok: true as const,
        calculation: {} as never,
        persisted: null,
      }),
    }),
  });

  assert.equal(listed, false);
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, failures: [] });
});
