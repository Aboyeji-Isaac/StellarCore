import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS,
  MIN_REPUTATION_OUTCOMES,
  REPUTATION_CONFIGURATION_REVISION,
  REPUTATION_EVIDENCE_MANIFEST_SCHEMA_VERSION,
  REPUTATION_FRESHNESS_POLICY_VERSION,
  REPUTATION_REASON_CODE_VOCABULARY_VERSION,
  REPUTATION_SCORING_POLICY_VERSION,
} from "@/constants/reputation";
import {
  buildReputationEvidenceManifest,
  inspectReputationManifest,
} from "@/lib/reputation/manifest";
import type {
  ReputationEvidence,
  ReputationManifestRecord,
} from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const WINDOW_START = new Date("2026-06-02T12:00:00.000Z");

test("manifest records the exact versions, window, and evaluated anchor state", () => {
  const manifest = buildReputationEvidenceManifest({
    evidence: evidence(),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });

  assert.equal(manifest.manifestSchemaVersion, REPUTATION_EVIDENCE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.reasonCodeVocabularyVersion, REPUTATION_REASON_CODE_VOCABULARY_VERSION);
  assert.equal(manifest.scoringPolicyVersion, REPUTATION_SCORING_POLICY_VERSION);
  assert.equal(manifest.freshnessPolicyVersion, REPUTATION_FRESHNESS_POLICY_VERSION);
  assert.equal(manifest.configurationRevision, REPUTATION_CONFIGURATION_REVISION);
  assert.equal(manifest.anchorId, "anchor-id");
  assert.equal(manifest.anchorStatus, "LIVE");
  assert.equal(manifest.evaluatedAt.toISOString(), NOW.toISOString());
  assert.equal(manifest.outcomeWindowStart.toISOString(), WINDOW_START.toISOString());
  assert.equal(manifest.minimumOutcomeCount, MIN_REPUTATION_OUTCOMES);
});

test("manifest is deterministic under input reordering", () => {
  const first = buildReputationEvidenceManifest({
    evidence: evidence(),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });
  const shuffled = buildReputationEvidenceManifest({
    evidence: evidence({
      corridors: [
        { corridorId: "corridor-b-id", slug: "b" },
        { corridorId: "corridor-a-id", slug: "a" },
      ],
      rates: [
        rate({ rateSnapshotId: "rate-b", corridorId: "corridor-b-id", corridorSlug: "b", ageMs: 5_000 }),
        rate({ rateSnapshotId: "rate-a", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 1_000 }),
      ],
      outcomes: [
        outcome({ transferOutcomeId: "outcome-2", index: 2 }),
        outcome({ transferOutcomeId: "outcome-1", index: 1 }),
      ],
    }),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });

  assert.deepEqual(shuffled, first);
  assert.deepEqual(
    first.outcomeMembers.map(({ transferOutcomeId }) => transferOutcomeId),
    ["outcome-2", "outcome-1"],
  );
  assert.deepEqual(
    first.rateMembers.map(({ ordinal, rateSnapshotId }) => [ordinal, rateSnapshotId]),
    [[0, "rate-a"], [1, "rate-b"]],
  );
});

test("eligible, stale, future, and non-member evidence are classified deterministically", () => {
  const manifest = buildReputationEvidenceManifest({
    evidence: evidence({
      corridors: [{ corridorId: "corridor-a-id", slug: "a" }],
      rates: [
        rate({ rateSnapshotId: "fresh", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 1_000 }),
        rate({ rateSnapshotId: "stale", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 120_001 }),
        rate({ rateSnapshotId: "future", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: -1_000 }),
        rate({ rateSnapshotId: "non-member", corridorId: "corridor-z-id", corridorSlug: "z", ageMs: 1_000 }),
      ],
      outcomes: [
        outcome({ transferOutcomeId: "eligible", index: 10 }),
        outcome({ transferOutcomeId: "future-outcome", index: -5 }),
      ],
    }),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });

  const byRate = new Map(manifest.rateMembers.map((member) => [member.rateSnapshotId, member]));
  assert.deepEqual(
    [byRate.get("fresh")?.eligibility, byRate.get("fresh")?.reasonCode],
    ["ELIGIBLE", "NONE"],
  );
  assert.deepEqual(
    [byRate.get("stale")?.eligibility, byRate.get("stale")?.reasonCode],
    ["EXCLUDED", "STALE_RATE"],
  );
  assert.deepEqual(
    [byRate.get("future")?.eligibility, byRate.get("future")?.reasonCode],
    ["EXCLUDED", "FUTURE_TIMESTAMP"],
  );
  assert.deepEqual(
    [byRate.get("non-member")?.eligibility, byRate.get("non-member")?.reasonCode],
    ["EXCLUDED", "RETIRED_OR_NON_MEMBER"],
  );
  assert.equal(byRate.get("non-member")?.corridorId, "corridor-z-id");

  const byOutcome = new Map(
    manifest.outcomeMembers.map((member) => [member.transferOutcomeId, member]),
  );
  assert.deepEqual(
    [byOutcome.get("eligible")?.eligibility, byOutcome.get("eligible")?.reasonCode],
    ["ELIGIBLE", "NONE"],
  );
  assert.deepEqual(
    [byOutcome.get("future-outcome")?.eligibility, byOutcome.get("future-outcome")?.reasonCode],
    ["EXCLUDED", "FUTURE_TIMESTAMP"],
  );

  assert.equal(manifest.freshRateCount, 1);
  assert.equal(manifest.outcomeCount, 1);
});

test("a zero-outcome manifest is truthful and never invents membership", () => {
  const manifest = buildReputationEvidenceManifest({
    evidence: evidence({ outcomes: [] , outsideOutcomeCount: 7 }),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });

  assert.equal(manifest.outcomeCount, 0);
  assert.equal(manifest.completedOutcomeCount, 0);
  assert.equal(manifest.outsideOutcomeCount, 7);
  assert.deepEqual(manifest.outcomeMembers, []);
});

test("non-member rate evidence is excluded from the fresh count", () => {
  const manifest = buildReputationEvidenceManifest({
    evidence: evidence({
      corridors: [],
      rates: [rate({ rateSnapshotId: "r", corridorId: "c", corridorSlug: "c", ageMs: 1 })],
    }),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });

  assert.equal(manifest.corridorCount, 0);
  assert.equal(manifest.latestRateCount, 1);
  assert.equal(manifest.freshRateCount, 0);
});

test("inspection maps a missing manifest to explicit legacy lineage", () => {
  const inspection = inspectReputationManifest(null);
  assert.deepEqual(inspection, {
    manifestAvailable: false,
    lineage: "legacy_or_unknown",
    reason: "NO_MANIFEST_FOR_EVALUATION",
  });
});

test("inspection is bounded, sanitized, and reports truncation", () => {
  const inspection = inspectReputationManifest(record(), 2);
  assert.equal(inspection.manifestAvailable, true);
  if (!inspection.manifestAvailable) return;
  assert.equal(inspection.manifest.rateMembers.length, 2);
  assert.equal(inspection.manifest.truncated.rateMembers, true);
  assert.equal(inspection.manifest.truncated.outcomeMembers, false);
  assert.equal(inspection.manifest.counts.latestRateCount, 4);
  assert.equal(inspection.manifest.anchorSlug, "anchor");
  assert.equal(inspection.manifest.rateMembers[0]?.reasonCode, "NONE");
  assert.equal(MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS > 2, true);
});

test("building a manifest does not mutate its input arrays", () => {
  const rates = [
    rate({ rateSnapshotId: "b", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 2 }),
    rate({ rateSnapshotId: "a", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 1 }),
  ];
  const snapshot = [...rates];
  buildReputationEvidenceManifest({
    evidence: evidence({ rates }),
    evaluatedAt: NOW,
    outcomeWindowStart: WINDOW_START,
  });
  assert.deepEqual(rates.map(({ rateSnapshotId }) => rateSnapshotId), snapshot.map(({ rateSnapshotId }) => rateSnapshotId));
});

function rate(options: {
  rateSnapshotId: string;
  corridorId: string;
  corridorSlug: string;
  ageMs: number;
}): ReputationEvidence["latestRates"][number] {
  return Object.freeze({
    rateSnapshotId: options.rateSnapshotId,
    corridorId: options.corridorId,
    corridorSlug: options.corridorSlug,
    capturedAt: new Date(NOW.getTime() - options.ageMs),
  });
}

function outcome(options: {
  transferOutcomeId: string;
  index: number;
}): ReputationEvidence["transferOutcomes"][number] {
  return Object.freeze({
    transferOutcomeId: options.transferOutcomeId,
    corridorId: "corridor-a-id",
    status: "COMPLETED" as const,
    settlementMs: 1_000,
    slippage: 0,
    recordedAt: new Date(NOW.getTime() - options.index * 1_000),
  });
}

function evidence(overrides: {
  corridors?: ReputationEvidence["corridors"];
  rates?: ReputationEvidence["latestRates"];
  outcomes?: ReputationEvidence["transferOutcomes"];
  outsideOutcomeCount?: number;
} = {}): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: "LIVE",
    corridors: overrides.corridors ?? [
      { corridorId: "corridor-a-id", slug: "a" },
      { corridorId: "corridor-b-id", slug: "b" },
    ],
    latestRates: overrides.rates ?? [
      rate({ rateSnapshotId: "rate-a", corridorId: "corridor-a-id", corridorSlug: "a", ageMs: 1_000 }),
      rate({ rateSnapshotId: "rate-b", corridorId: "corridor-b-id", corridorSlug: "b", ageMs: 5_000 }),
    ],
    transferOutcomes: overrides.outcomes ?? [
      outcome({ transferOutcomeId: "outcome-1", index: 1 }),
      outcome({ transferOutcomeId: "outcome-2", index: 2 }),
    ],
    outsideOutcomeCount: overrides.outsideOutcomeCount ?? 0,
  });
}

function record(): ReputationManifestRecord {
  return Object.freeze({
    id: "manifest-id",
    reputationScoreId: "score-id",
    anchorSlug: "anchor",
    anchorStatus: "LIVE",
    manifestSchemaVersion: 1,
    reasonCodeVocabularyVersion: 1,
    scoringPolicyVersion: REPUTATION_SCORING_POLICY_VERSION,
    freshnessPolicyVersion: REPUTATION_FRESHNESS_POLICY_VERSION,
    configurationRevision: REPUTATION_CONFIGURATION_REVISION,
    evaluatedAt: NOW.toISOString(),
    outcomeWindowStart: WINDOW_START.toISOString(),
    corridorCount: 1,
    latestRateCount: 4,
    freshRateCount: 2,
    outcomeCount: 3,
    completedOutcomeCount: 3,
    outsideOutcomeCount: 0,
    minimumOutcomeCount: MIN_REPUTATION_OUTCOMES,
    createdAt: NOW.toISOString(),
    corridorMembers: Object.freeze([
      { corridorId: "corridor-a-id", membership: "MEMBER" as const, reasonCode: "NONE" as const, ordinal: 0 },
    ]),
    rateMembers: Object.freeze(Array.from({ length: 4 }, (_, index) => Object.freeze({
      rateSnapshotId: `rate-${index}`,
      corridorId: "corridor-a-id",
      capturedAt: NOW.toISOString(),
      ageMs: index * 100,
      eligibility: "ELIGIBLE" as const,
      reasonCode: "NONE" as const,
      ordinal: index,
    }))),
    outcomeMembers: Object.freeze([
      {
        transferOutcomeId: "outcome-1",
        corridorId: "corridor-a-id",
        status: "COMPLETED" as const,
        recordedAt: NOW.toISOString(),
        eligibility: "ELIGIBLE" as const,
        reasonCode: "NONE" as const,
        ordinal: 0,
      },
    ]),
  });
}
