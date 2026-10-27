import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { evaluatePersistedAnchorReputations } from "@/lib/reputation/run";
import type { ReputationRepository } from "@/types/reputation";
import {
  faultReputationRepository,
  reputationLedger,
  type ReputationLedger,
} from "./faultKit.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");

// [P1] Evidence-read database fault: the evaluation fails safely with
// EVIDENCE_READ_FAILURE and nothing is persisted.
test("[P1] evidence-read fault fails safely with no score write", async () => {
  const ledger = reputationLedger();
  const repository = reputationRepository(ledger, evidence(), {
    readEvidence: ["fault:DB_TIMEOUT"],
  });

  const result = await evaluateAnchorReputation("zeam", {
    repository,
    evaluatedAt: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === "EVIDENCE_READ_FAILURE");
  assert.equal(ledger.upserts(), 0);
});

// [P2] Score-write fault after a successful read: the calculation happened
// but nothing durable changed; the failure is PERSISTENCE_FAILURE.
test("[P2] score-write fault leaves no persisted score and reports PERSISTENCE_FAILURE", async () => {
  const ledger = reputationLedger();
  const repository = reputationRepository(ledger, evidence(), {
    upsertScore: ["fault:DB_CONNECTION_LOST"],
  });

  const result = await evaluateAnchorReputation("zeam", {
    repository,
    evaluatedAt: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === "PERSISTENCE_FAILURE");
  assert.equal(ledger.upserts(), 0);
});

// [P3] Partial run: one anchor's evidence read fails, the others still
// evaluate and persist; the summary counts both truths.
test("[P3] per-anchor isolation keeps healthy anchors evaluated while reporting the failed one", async () => {
  const ledger = reputationLedger();
  const evidenceTable = {
    zeam: evidence().zeam,
    moneygram: evidence().moneygram,
    cowrie: evidence().cowrie,
  };
  const repository = reputationRepository(ledger, evidenceTable, {
    // Sequence by call order of evaluatePersistedAnchorReputations, which is
    // the sorted slug order: cowrie, moneygram, zeam.
    readEvidence: ["ok", "fault:DB_TIMEOUT", "ok"],
  });

  const summary = await evaluatePersistedAnchorReputations({
    anchorSlugs: ["zeam", "moneygram", "cowrie"],
    evaluatedAt: NOW,
    dependencies: {
      listAnchorSlugs: async () => ["zeam", "moneygram", "cowrie"],
      evaluate: (slug) => evaluateAnchorReputation(slug, { repository, evaluatedAt: NOW }),
    },
  });

  assert.equal(summary.attempted, 3);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failures, [{ anchorSlug: "moneygram", code: "EVIDENCE_READ_FAILURE" }]);
  assert.equal(ledger.upserts(), 2);
  assert.ok(ledger.scores.get("anchor:cowrie"));
  assert.ok(ledger.scores.get("anchor:zeam"));
  assert.equal(ledger.scores.get("anchor:moneygram"), undefined);
});

// [P4] Rerun after a partial write failure: a rerun persists the missing
// score and recomputes deterministically from the same evidence, with the
// same computed evaluation time passed by the caller.
test("[P4] rerun after partial reputation failure completes deterministically", async () => {
  const ledger = reputationLedger();
  const evidenceTable = evidence();

  const faulted = reputationRepository(ledger, evidenceTable, {
    upsertScore: ["ok", "fault:DB_CONNECTION_LOST"],
  });
  const first = await runThreeAnchors(faulted, NOW);
  assert.equal(first.succeeded, 2);
  assert.equal(first.failed, 1);
  assert.equal(ledger.upserts(), 2);

  // A rerun over the same evidence and evaluation time fills the gap.
  const healthy = reputationRepository(ledger, evidenceTable);
  const second = await runThreeAnchors(healthy, NOW);
  assert.equal(second.succeeded, 3);
  assert.equal(second.failed, 0);
  assert.equal(ledger.upserts(), 5);
  assert.deepEqual(
    Object.keys(ledger.computedAtBySlug()).sort(),
    ["cowrie", "moneygram", "zeam"],
  );
});

// [P5] Repeated reruns are idempotent upserts: the score set does not grow
// and the computed values for the same evidence stay identical.
test("[P5] repeated reruns upsert idempotently without inventing new identities", async () => {
  const ledger = reputationLedger();
  const evidenceTable = evidence();

  for (let index = 0; index < 3; index += 1) {
    const repository = reputationRepository(ledger, evidenceTable);
    const summary = await runThreeAnchors(repository, NOW);
    assert.equal(summary.succeeded, 3);
  }

  assert.equal(ledger.upserts(), 9);
  assert.deepEqual(
    Object.keys(ledger.computedAtBySlug()).sort(),
    ["cowrie", "moneygram", "zeam"],
  );
});

// [P6] Deadline during evidence read fails safely and writes nothing.
test("[P6] deadline-exceeded during evidence read maps to EVIDENCE_READ_FAILURE with no writes", async () => {
  const ledger = reputationLedger();
  const repository = reputationRepository(ledger, evidence(), {
    readEvidence: ["deadline:DEADLINE_EXCEEDED"],
  });

  const result = await evaluateAnchorReputation("zeam", {
    repository,
    evaluatedAt: NOW,
  });

  assert.ok(!result.ok && result.code === "EVIDENCE_READ_FAILURE");
  assert.equal(ledger.upserts(), 0);
});

// [P7] An anchor with genuinely sparse evidence still gets its truthful
// insufficient-data evaluation persisted under fault conditions — the write
// path does not upgrade or fabricate a score.
test("[P7] sparse evidence under fault conditions persists truthful insufficient data", async () => {
  const ledger = reputationLedger();
  const repository = reputationRepository(ledger, {
    zeam: {
      anchorId: "anchor:zeam",
      status: "LIVE",
      corridorSlugs: ["usdc-us-brl-br"],
      latestRateCount: 1,
      // Below the 30-outcome minimum: no established score may be published.
      outcomeCount: 2,
      completedOutcomeCount: 2,
    },
  });

  const result = await evaluateAnchorReputation("zeam", {
    repository,
    evaluatedAt: NOW,
  });

  assert.ok(result.ok);
  assert.equal(result.calculation.state, "insufficient_evidence");
  assert.equal(result.calculation.score, null);
  assert.equal(result.calculation.scoreBand, null);
  assert.equal(ledger.upserts(), 1);
});

function evidence(): Readonly<Record<string, {
  anchorId: string;
  status: "LIVE" | "DEGRADED" | "DOWN" | "UNKNOWN";
  corridorSlugs: readonly string[];
  latestRateCount: number;
  outcomeCount: number;
  completedOutcomeCount: number;
}>> {
  return {
    zeam: {
      anchorId: "anchor:zeam",
      status: "LIVE",
      corridorSlugs: ["usdc-us-brl-br"],
      latestRateCount: 1,
      outcomeCount: 30,
      completedOutcomeCount: 30,
    },
    moneygram: {
      anchorId: "anchor:moneygram",
      status: "LIVE",
      corridorSlugs: ["usdc-us-usd-us"],
      latestRateCount: 1,
      outcomeCount: 30,
      completedOutcomeCount: 28,
    },
    cowrie: {
      anchorId: "anchor:cowrie",
      status: "LIVE",
      corridorSlugs: ["ngnt-ng-ngn-ng"],
      latestRateCount: 1,
      outcomeCount: 30,
      completedOutcomeCount: 25,
    },
  };
}

async function runThreeAnchors(
  repository: ReputationRepository,
  evaluatedAt: Date,
) {
  return evaluatePersistedAnchorReputations({
    anchorSlugs: ["zeam", "moneygram", "cowrie"],
    evaluatedAt,
    dependencies: {
      listAnchorSlugs: async () => ["zeam", "moneygram", "cowrie"],
      evaluate: (slug) => evaluateAnchorReputation(slug, { repository, evaluatedAt }),
    },
  });
}

function reputationRepository(
  ledger: ReputationLedger,
  evidenceTable: Parameters<typeof faultReputationRepository>[1],
  faults: Parameters<typeof faultReputationRepository>[2] = {},
): ReputationRepository {
  return faultReputationRepository(ledger, evidenceTable, faults) as unknown as ReputationRepository;
}
