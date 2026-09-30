import {
  MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS,
  MIN_REPUTATION_OUTCOMES,
  REPUTATION_CONFIGURATION_REVISION,
  REPUTATION_EVIDENCE_MANIFEST_SCHEMA_VERSION,
  REPUTATION_FRESHNESS_POLICY_VERSION,
  REPUTATION_REASON_CODE_VOCABULARY_VERSION,
  REPUTATION_SCORING_POLICY_VERSION,
} from "@/constants/reputation";
import { getRateFreshness } from "@/lib/rates/freshness";
import type {
  ReputationEvidence,
  ReputationEvidenceEligibilityValue,
  ReputationEvidenceManifestDraft,
  ReputationEvidenceReasonCodeValue,
  ReputationManifestRecord,
  ReputationRateEvidence,
} from "@/types/reputation";

/**
 * Pure evidence-set manifest construction.
 *
 * The manifest records exactly which persisted rows were read for one
 * evaluation and how each was classified. It is deterministic: members are
 * sorted by stable keys and re-reading the same evidence always serializes
 * identically. It performs no I/O, copies no raw remote response, secret, or
 * mutable display text, and never fabricates membership — an evaluation with
 * zero in-window outcomes truthfully produces a manifest with zero outcome
 * members.
 */
export function buildReputationEvidenceManifest(input: Readonly<{
  evidence: ReputationEvidence;
  evaluatedAt: Date;
  outcomeWindowStart: Date;
}>): ReputationEvidenceManifestDraft {
  const { evidence, evaluatedAt, outcomeWindowStart } = input;
  const corridorSlugs = new Set(evidence.corridors.map(({ slug }) => slug));

  const corridorMembers = Object.freeze([...evidence.corridors]
    .sort((left, right) =>
      left.slug.localeCompare(right.slug)
      || left.corridorId.localeCompare(right.corridorId))
    .map((corridor, ordinal) => Object.freeze({
      corridorId: corridor.corridorId,
      membership: "MEMBER" as const,
      reasonCode: "NONE" as const,
      ordinal,
    })));

  const rateMembers = Object.freeze([...evidence.latestRates]
    .sort((left, right) => compareRatesDeterministically(left, right))
    .map((rate, ordinal) =>
      classifyRateMember(rate, corridorSlugs, evaluatedAt, ordinal)));

  const outcomeMembers = Object.freeze([...evidence.transferOutcomes]
    .sort((left, right) =>
      timestampOrMinimum(left.recordedAt) - timestampOrMinimum(right.recordedAt)
      || left.transferOutcomeId.localeCompare(right.transferOutcomeId))
    .map((outcome, ordinal) => {
      const recordedAt = toDate(outcome.recordedAt);
      const recordedMs = timestamp(outcome.recordedAt);
      const future = recordedMs !== null && recordedMs > evaluatedAt.getTime();
      const eligibility: ReputationEvidenceEligibilityValue = recordedMs === null
        ? "EXCLUDED"
        : future
          ? "EXCLUDED"
          : "ELIGIBLE";
      const reasonCode: ReputationEvidenceReasonCodeValue = recordedMs === null
        ? "INVALID_TIMESTAMP"
        : future
          ? "FUTURE_TIMESTAMP"
          : "NONE";

      return Object.freeze({
        transferOutcomeId: outcome.transferOutcomeId,
        corridorId: outcome.corridorId,
        status: outcome.status,
        recordedAt,
        eligibility,
        reasonCode,
        ordinal,
      });
    }));

  const freshRateCount = rateMembers.filter(({ eligibility }) =>
    eligibility === "ELIGIBLE").length;
  const eligibleOutcomes = outcomeMembers.filter(({ eligibility }) =>
    eligibility === "ELIGIBLE");
  const completedOutcomeCount = eligibleOutcomes.filter(({ status }) =>
    status === "COMPLETED").length;

  return Object.freeze({
    manifestSchemaVersion: REPUTATION_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    reasonCodeVocabularyVersion: REPUTATION_REASON_CODE_VOCABULARY_VERSION,
    scoringPolicyVersion: REPUTATION_SCORING_POLICY_VERSION,
    freshnessPolicyVersion: REPUTATION_FRESHNESS_POLICY_VERSION,
    configurationRevision: REPUTATION_CONFIGURATION_REVISION,
    anchorId: evidence.anchorId,
    anchorStatus: evidence.status,
    evaluatedAt: new Date(evaluatedAt.getTime()),
    outcomeWindowStart: new Date(outcomeWindowStart.getTime()),
    corridorCount: evidence.corridors.length,
    latestRateCount: rateMembers.length,
    freshRateCount,
    outcomeCount: eligibleOutcomes.length,
    completedOutcomeCount,
    outsideOutcomeCount: Math.max(0, Math.trunc(evidence.outsideOutcomeCount)),
    minimumOutcomeCount: MIN_REPUTATION_OUTCOMES,
    corridorMembers,
    rateMembers,
    outcomeMembers,
  });
}

function classifyRateMember(
  rate: ReputationRateEvidence,
  corridorSlugs: ReadonlySet<string>,
  evaluatedAt: Date,
  ordinal: number,
): ReputationEvidenceManifestDraft["rateMembers"][number] {
  const freshness = getRateFreshness(rate.capturedAt, evaluatedAt);

  let eligibility: ReputationEvidenceEligibilityValue;
  let reasonCode: ReputationEvidenceReasonCodeValue;

  if (!corridorSlugs.has(rate.corridorSlug)) {
    // A persisted observation for a corridor the anchor is not currently a
    // member of is excluded rather than treated as current membership: the
    // relationship is classified by the reason vocabulary, not reconstructed.
    eligibility = "EXCLUDED";
    reasonCode = "RETIRED_OR_NON_MEMBER";
  } else if (freshness.state === "fresh") {
    eligibility = "ELIGIBLE";
    reasonCode = "NONE";
  } else if (freshness.state === "stale") {
    eligibility = "EXCLUDED";
    reasonCode = "STALE_RATE";
  } else if (freshness.state === "future") {
    eligibility = "EXCLUDED";
    reasonCode = "FUTURE_TIMESTAMP";
  } else {
    eligibility = "EXCLUDED";
    reasonCode = "INVALID_TIMESTAMP";
  }

  return Object.freeze({
    rateSnapshotId: rate.rateSnapshotId,
    corridorId: rate.corridorId,
    capturedAt: toDate(rate.capturedAt),
    ageMs: freshness.ageMs === null ? null : Math.trunc(freshness.ageMs),
    eligibility,
    reasonCode,
    ordinal,
  });
}

function compareRatesDeterministically(
  left: ReputationRateEvidence,
  right: ReputationRateEvidence,
): number {
  const byCorridor = left.corridorSlug.localeCompare(right.corridorSlug);
  if (byCorridor !== 0) return byCorridor;

  const leftMs = timestampOrMinimum(left.capturedAt);
  const rightMs = timestampOrMinimum(right.capturedAt);
  if (leftMs !== rightMs) return rightMs - leftMs;

  return left.rateSnapshotId.localeCompare(right.rateSnapshotId);
}

export type ReputationManifestInspection =
  | Readonly<{
      manifestAvailable: false;
      lineage: "legacy_or_unknown";
      reason: "NO_MANIFEST_FOR_EVALUATION";
    }>
  | Readonly<{
      manifestAvailable: true;
      manifest: Readonly<{
        id: string;
        reputationScoreId: string;
        anchorSlug: string;
        anchorStatus: string;
        manifestSchemaVersion: number;
        reasonCodeVocabularyVersion: number;
        scoringPolicyVersion: string;
        freshnessPolicyVersion: string;
        configurationRevision: string;
        evaluatedAt: string;
        outcomeWindowStart: string;
        counts: Readonly<{
          corridorCount: number;
          latestRateCount: number;
          freshRateCount: number;
          outcomeCount: number;
          completedOutcomeCount: number;
          outsideOutcomeCount: number;
          minimumOutcomeCount: number;
        }>;
        createdAt: string;
        corridorMembers: readonly ReputationManifestRecord["corridorMembers"][number][];
        rateMembers: readonly ReputationManifestRecord["rateMembers"][number][];
        outcomeMembers: readonly ReputationManifestRecord["outcomeMembers"][number][];
        truncated: Readonly<{
          corridorMembers: boolean;
          rateMembers: boolean;
          outcomeMembers: boolean;
        }>;
      }>;
    }>;

/**
 * Bounded, sanitized projection of one persisted manifest for internal
 * inspection. Only stable IDs, enum classifications, and bounded counts are
 * emitted; raw amounts, authorization material, and mutable display text never
 * appear. Member lists are capped so a single operator read stays small.
 */
export function inspectReputationManifest(
  record: ReputationManifestRecord | null,
  maxMembers: number = MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS,
): ReputationManifestInspection {
  if (record === null) {
    return Object.freeze({
      manifestAvailable: false as const,
      lineage: "legacy_or_unknown" as const,
      reason: "NO_MANIFEST_FOR_EVALUATION" as const,
    });
  }

  const limit = Math.max(0, Math.trunc(maxMembers));
  const corridorMembers = record.corridorMembers.slice(0, limit);
  const rateMembers = record.rateMembers.slice(0, limit);
  const outcomeMembers = record.outcomeMembers.slice(0, limit);

  return Object.freeze({
    manifestAvailable: true as const,
    manifest: Object.freeze({
      id: record.id,
      reputationScoreId: record.reputationScoreId,
      anchorSlug: record.anchorSlug,
      anchorStatus: record.anchorStatus,
      manifestSchemaVersion: record.manifestSchemaVersion,
      reasonCodeVocabularyVersion: record.reasonCodeVocabularyVersion,
      scoringPolicyVersion: record.scoringPolicyVersion,
      freshnessPolicyVersion: record.freshnessPolicyVersion,
      configurationRevision: record.configurationRevision,
      evaluatedAt: record.evaluatedAt,
      outcomeWindowStart: record.outcomeWindowStart,
      counts: Object.freeze({
        corridorCount: record.corridorCount,
        latestRateCount: record.latestRateCount,
        freshRateCount: record.freshRateCount,
        outcomeCount: record.outcomeCount,
        completedOutcomeCount: record.completedOutcomeCount,
        outsideOutcomeCount: record.outsideOutcomeCount,
        minimumOutcomeCount: record.minimumOutcomeCount,
      }),
      createdAt: record.createdAt,
      corridorMembers: Object.freeze(corridorMembers),
      rateMembers: Object.freeze(rateMembers),
      outcomeMembers: Object.freeze(outcomeMembers),
      truncated: Object.freeze({
        corridorMembers: corridorMembers.length < record.corridorMembers.length,
        rateMembers: rateMembers.length < record.rateMembers.length,
        outcomeMembers: outcomeMembers.length < record.outcomeMembers.length,
      }),
    }),
  });
}

export function formatReputationManifestInspection(
  record: ReputationManifestRecord | null,
  maxMembers: number = MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS,
): string {
  return `${JSON.stringify(inspectReputationManifest(record, maxMembers), null, 2)}\n`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function timestamp(value: Date | string): number | null {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function timestampOrMinimum(value: Date | string): number {
  return timestamp(value) ?? Number.NEGATIVE_INFINITY;
}
