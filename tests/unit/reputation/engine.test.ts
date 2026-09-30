import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import type {
  ReputationEvidence,
  ReputationRepository,
  ReputationUpsertResult,
} from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");

test("engine reads one 90-day window and can calculate without persistence", async () => {
  let windowStart: Date | undefined;
  let writes = 0;
  const result = await evaluateAnchorReputation("anchor", {
    evaluatedAt: NOW,
    persist: false,
    repository: repository({
      readEvidence: async (_slug, start) => {
        windowStart = start;
        return sparseEvidence();
      },
      upsertScore: async () => {
        writes += 1;
        return upsertResult();
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(windowStart?.toISOString(), "2026-06-02T12:00:00.000Z");
  assert.equal(writes, 0);
  if (result.ok) assert.equal(result.persisted, null);
});

test("persistence upserts current score rather than appending history", async () => {
  let rowId: string | undefined;
  let writeCount = 0;
  const repo = repository({
    upsertScore: async ({ calculation }) => {
      writeCount += 1;
      rowId ??= "one-current-row";
      return Object.freeze({
        ok: true,
        score: Object.freeze({
          id: rowId,
          anchorSlug: calculation.anchorSlug,
          computedAt: new Date(calculation.computedAt),
        }),
      });
    },
  });

  const first = await evaluateAnchorReputation("anchor", { repository: repo, evaluatedAt: NOW });
  const second = await evaluateAnchorReputation("anchor", {
    repository: repo,
    evaluatedAt: new Date(NOW.getTime() + 1_000),
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(writeCount, 2);
  if (first.ok && second.ok) assert.equal(first.persisted?.id, second.persisted?.id);
});

test("stale write returns ok with null persisted", async () => {
  const repo = repository({
    upsertScore: async () => {
      return Object.freeze({
        ok: false,
        code: "STALE_WRITE",
        existingComputedAt: new Date(NOW.getTime() + 1_000),
      });
    },
  });

  const result = await evaluateAnchorReputation("anchor", { repository: repo, evaluatedAt: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.persisted, null);
  if (result.ok) assert.equal(result.calculation.anchorSlug, "anchor");
});

test("missing anchors and repository failures are safely classified", async () => {
  const missing = await evaluateAnchorReputation("missing", {
    repository: repository({ readEvidence: async () => null }),
  });
  const readFailure = await evaluateAnchorReputation("anchor", {
    repository: repository({
      readEvidence: async () => { throw new Error("DATABASE_URL=secret"); },
    }),
  });
  const writeFailure = await evaluateAnchorReputation("anchor", {
    repository: repository({
      upsertScore: async () => { throw new Error("Prisma secret"); },
    }),
  });

  assert.deepEqual(missing, { ok: false, anchorSlug: "missing", code: "ANCHOR_NOT_FOUND" });
  assert.equal(readFailure.ok, false);
  assert.equal(writeFailure.ok, false);
  if (!readFailure.ok) assert.equal(readFailure.code, "EVIDENCE_READ_FAILURE");
  if (!writeFailure.ok) assert.equal(writeFailure.code, "PERSISTENCE_FAILURE");
  assert.equal(JSON.stringify({ readFailure, writeFailure }).includes("secret"), false);
});

test("invalid evaluation time is rejected before repository access", async () => {
  let accessed = false;
  const result = await evaluateAnchorReputation("anchor", {
    evaluatedAt: new Date("invalid"),
    repository: repository({
      readEvidence: async () => {
        accessed = true;
        return sparseEvidence();
      },
    }),
  });
  assert.deepEqual(result, {
    ok: false,
    anchorSlug: "anchor",
    code: "INVALID_EVALUATION_TIME",
  });
  assert.equal(accessed, false);
});

test("concurrent evaluations with inverted completion order - newer wins", async () => {
  // Simulates: Evaluation A starts first (older computedAt), Evaluation B starts later (newer computedAt)
  // But Evaluation A's database write completes AFTER Evaluation B's write
  // The atomic guard should ensure B's newer score wins

  let persistedComputedAt: Date | undefined;
  let persistedId: string | undefined;
  let evaluationBCalled = false;

  const repo = repository({
    upsertScore: async ({ calculation }) => {
      const computedAt = new Date(calculation.computedAt);
      
      // Track which evaluation this is
      const isEvaluationA = computedAt.getTime() === NOW.getTime();
      
      if (isEvaluationA) {
        // Evaluation A (older) - simulate slow completion
        // Wait for Evaluation B to be called first
        while (!evaluationBCalled) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      } else {
        // Evaluation B (newer) - marks as called
        evaluationBCalled = true;
      }

      // The database will handle the atomic compare-and-swap
      // We simulate the database behavior here
      if (persistedComputedAt === undefined) {
        // First write always succeeds
        persistedComputedAt = computedAt;
        persistedId = `score-${isEvaluationA ? "A" : "B"}`;
        return Object.freeze({
          ok: true,
          score: Object.freeze({ id: persistedId, anchorSlug: "anchor", computedAt: persistedComputedAt }),
        });
      }

      // Subsequent writes: only succeed if strictly newer (or equal with deterministic tiebreaker)
      if (computedAt > persistedComputedAt!) {
        persistedComputedAt = computedAt;
        persistedId = `score-${isEvaluationA ? "A" : "B"}`;
        return Object.freeze({
          ok: true,
          score: Object.freeze({ id: persistedId, anchorSlug: "anchor", computedAt: persistedComputedAt }),
        });
      }

      // Stale write
      return Object.freeze({
        ok: false,
        code: "STALE_WRITE",
        existingComputedAt: persistedComputedAt!,
      });
    },
  });

  // Start both evaluations concurrently
  // Evaluation A has earlier evaluatedAt (older)
  // Evaluation B has later evaluatedAt (newer)
  const [resultA, resultB] = await Promise.all([
    evaluateAnchorReputation("anchor", { repository: repo, evaluatedAt: NOW }),
    evaluateAnchorReputation("anchor", { 
      repository: repo, 
      evaluatedAt: new Date(NOW.getTime() + 1_000) 
    }),
  ]);

  // Both evaluations should report success (ok: true)
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);

  // But only the newer evaluation (B) should have its score persisted
  // The older evaluation (A) should get null persisted due to stale write
  if (resultA.ok && resultB.ok) {
    assert.equal(resultA.persisted, null, "Older evaluation should not persist due to stale write");
    assert.notEqual(resultB.persisted, null, "Newer evaluation should persist");
    assert.equal(resultB.persisted?.computedAt.getTime(), NOW.getTime() + 1_000);
  }
});

test("equal timestamps resolve deterministically (first writer wins)", async () => {
  // Two evaluations with the exact same evaluatedAt
  // The database should allow only one to persist (first writer wins)
  let writeCount = 0;
  let firstWriterId: string | undefined;

  const repo = repository({
    upsertScore: async ({ calculation }) => {
      writeCount += 1;
      const computedAt = new Date(calculation.computedAt);
      
      if (writeCount === 1) {
        firstWriterId = `score-${writeCount}`;
        return Object.freeze({
          ok: true,
          score: Object.freeze({ id: firstWriterId, anchorSlug: "anchor", computedAt }),
        });
      }

      // Second write with same timestamp - should be stale
      return Object.freeze({
        ok: false,
        code: "STALE_WRITE",
        existingComputedAt: computedAt,
      });
    },
  });

  const [result1, result2] = await Promise.all([
    evaluateAnchorReputation("anchor", { repository: repo, evaluatedAt: NOW }),
    evaluateAnchorReputation("anchor", { repository: repo, evaluatedAt: NOW }),
  ]);

  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);
  assert.equal(writeCount, 2);

  // One should persist, one should be stale
  const persistedResults = [result1, result2].filter((r) => r.ok && r.persisted !== null);
  const staleResults = [result1, result2].filter((r) => r.ok && r.persisted === null);
  
  assert.equal(persistedResults.length, 1);
  assert.equal(staleResults.length, 1);
});

function repository(overrides: Partial<ReputationRepository>): ReputationRepository {
  return Object.freeze({
    readEvidence: async () => sparseEvidence(),
    upsertScore: async () => upsertResult(),
    ...overrides,
  });
}

function sparseEvidence(): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: "LIVE",
    corridorSlugs: Object.freeze([]),
    latestRates: Object.freeze([]),
    transferOutcomes: Object.freeze([]),
  });
}

function upsertResult(): ReputationUpsertResult {
  return Object.freeze({
    ok: true,
    score: Object.freeze({
      id: "score-id",
      anchorSlug: "anchor",
      computedAt: NOW,
    }),
  });
}
