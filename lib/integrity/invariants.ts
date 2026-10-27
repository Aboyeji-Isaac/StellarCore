import { MIN_REPUTATION_OUTCOMES, REPUTATION_BANDS } from "@/constants/reputation";
import { EVIDENCE_INTEGRITY_REMEDIATION } from "@/lib/integrity/remediation";
import type {
  EvidenceIntegrityAuditLimits,
  EvidenceIntegrityAuditSnapshot,
  EvidenceIntegrityFinding,
  EvidenceIntegrityReputationScoreRow,
  EvidenceIntegrityScoreBand,
  EvidenceIntegrityViolationCode,
} from "@/types/integrity";

const SIGNED_DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export type EvidenceIntegrityEvaluation = Readonly<{
  findingCount: number;
  suppressedFindingCount: number;
  findings: readonly EvidenceIntegrityFinding[];
}>;

/**
 * Pure, deterministic evaluation of the documented cross-table invariants.
 * It performs no I/O and never mutates its input. Findings are bounded by
 * `limits`, and the true `findingCount` is preserved even when output is
 * capped.
 */
export function evaluateEvidenceIntegrity(
  snapshot: EvidenceIntegrityAuditSnapshot,
  observedAt: Date,
  limits: EvidenceIntegrityAuditLimits,
): EvidenceIntegrityEvaluation {
  const observedAtMs = observedAt.getTime();
  const futureCutoff = observedAtMs + limits.futureTimestampToleranceMs;
  const anchorById = new Map(snapshot.anchors.map((anchor) => [anchor.id, anchor]));
  const corridorById = new Map(
    snapshot.corridors.map((corridor) => [corridor.id, corridor]),
  );
  const membershipKeys = new Set(snapshot.anchorCorridors.map((membership) =>
    membershipKey(membership.anchorId, membership.corridorId)));

  const buckets = new Map<EvidenceIntegrityViolationCode, EvidenceIntegrityFinding[]>();
  let findingCount = 0;

  const record = (finding: EvidenceIntegrityFinding): void => {
    findingCount += 1;
    const bucket = buckets.get(finding.code) ?? [];
    if (bucket.length < limits.maxFindingsPerCode) {
      bucket.push(finding);
      buckets.set(finding.code, bucket);
    }
  };

  // Deterministic iteration order keeps per-code selection stable when capped.
  const byId = <T extends { id: string }>(rows: readonly T[]): T[] =>
    [...rows].sort((left, right) => compareText(left.id, right.id));

  for (const snapshotRow of byId(snapshot.rateSnapshots)) {
    const anchor = anchorById.get(snapshotRow.anchorId);
    const corridor = corridorById.get(snapshotRow.corridorId);
    const base = entityBase(
      "rate_snapshot",
      snapshotRow.id,
      anchor?.slug,
      corridor?.slug,
    );

    if (!membershipKeys.has(
      membershipKey(snapshotRow.anchorId, snapshotRow.corridorId),
    )) {
      record(finding("RATE_SNAPSHOT_MEMBERSHIP_MISSING", base));
    }

    const capturedAtMs = snapshotRow.capturedAt.getTime();
    if (Number.isFinite(capturedAtMs)) {
      if (capturedAtMs > futureCutoff) {
        record(finding("RATE_SNAPSHOT_TIMESTAMP_FUTURE", base));
      }
      if (anchor && capturedAtMs < anchor.createdAt.getTime()) {
        record(finding("RATE_SNAPSHOT_TIMESTAMP_BEFORE_ANCHOR", base));
      }
    }

    const amounts = [
      decimalSign(snapshotRow.rate),
      decimalSign(snapshotRow.sourceAmount),
      decimalSign(snapshotRow.destinationAmount),
    ];
    if (amounts.some((sign) => sign !== 1)) {
      record(finding("RATE_SNAPSHOT_NON_POSITIVE_AMOUNT", base));
    }
    if (decimalSign(snapshotRow.fee) === -1) {
      record(finding("RATE_SNAPSHOT_NEGATIVE_FEE", base));
    }
  }

  for (const outcome of byId(snapshot.transferOutcomes)) {
    const anchor = anchorById.get(outcome.anchorId);
    const corridor = corridorById.get(outcome.corridorId);
    const base = entityBase(
      "transfer_outcome",
      outcome.id,
      anchor?.slug,
      corridor?.slug,
    );

    if (!membershipKeys.has(membershipKey(outcome.anchorId, outcome.corridorId))) {
      record(finding("TRANSFER_OUTCOME_MEMBERSHIP_MISSING", base));
    }

    const recordedAtMs = outcome.recordedAt.getTime();
    if (Number.isFinite(recordedAtMs)) {
      if (recordedAtMs > futureCutoff) {
        record(finding("TRANSFER_OUTCOME_TIMESTAMP_FUTURE", base));
      }
      if (anchor && recordedAtMs < anchor.createdAt.getTime()) {
        record(finding("TRANSFER_OUTCOME_TIMESTAMP_BEFORE_ANCHOR", base));
      }
    }

    if (
      !Number.isFinite(outcome.fillRate) ||
      !Number.isFinite(outcome.settlementMs) ||
      !Number.isFinite(outcome.slippage)
    ) {
      record(finding("TRANSFER_OUTCOME_INVALID_METRIC", base));
    } else {
      if (outcome.fillRate < 0 || outcome.fillRate > 1) {
        record(finding("TRANSFER_OUTCOME_FILL_RATE_OUT_OF_RANGE", base));
      }
      if (outcome.settlementMs < 0) {
        record(finding("TRANSFER_OUTCOME_NEGATIVE_SETTLEMENT", base));
      }
    }
  }

  for (const score of byId(snapshot.reputationScores)) {
    const anchor = anchorById.get(score.anchorId);
    const base = entityBase("reputation_score", score.id, anchor?.slug, undefined);

    const computedAtMs = score.computedAt.getTime();
    if (Number.isFinite(computedAtMs)) {
      if (computedAtMs > futureCutoff) {
        record(finding("REPUTATION_SCORE_TIMESTAMP_FUTURE", base));
      }
      if (anchor && computedAtMs < anchor.createdAt.getTime()) {
        record(finding("REPUTATION_SCORE_TIMESTAMP_BEFORE_ANCHOR", base));
      }
    }

    auditReputationScore(score, base, record);
  }

  auditDuplicateCorridorIdentities(snapshot.corridors, record);

  const selected = [...buckets.values()].flat()
    .sort(compareFindings)
    .slice(0, limits.maxFindings);

  return Object.freeze({
    findingCount,
    suppressedFindingCount: findingCount - selected.length,
    findings: Object.freeze(selected),
  });
}

function auditReputationScore(
  score: EvidenceIntegrityReputationScoreRow,
  base: Omit<EvidenceIntegrityFinding, "code" | "remediation">,
  record: (finding: EvidenceIntegrityFinding) => void,
): void {
  if (score.state === "OK") {
    if (score.compositeScore === null) {
      record(finding("REPUTATION_STATE_OK_WITHOUT_COMPOSITE_SCORE", base));
    }
    if (score.scoreBand === null) {
      record(finding("REPUTATION_STATE_OK_WITHOUT_SCORE_BAND", base));
    }
    if (score.sampleSize < MIN_REPUTATION_OUTCOMES) {
      record(finding("REPUTATION_STATE_OK_WITH_INSUFFICIENT_SAMPLE", base));
    }
  } else if (score.compositeScore !== null || score.scoreBand !== null) {
    record(finding("REPUTATION_INSUFFICIENT_DATA_WITH_SCORE", base));
  }

  if (score.sampleSize < 0) {
    record(finding("REPUTATION_SAMPLE_SIZE_NEGATIVE", base));
  }

  if (
    score.compositeScore !== null &&
    (score.compositeScore < 0 || score.compositeScore > 100)
  ) {
    record(finding("REPUTATION_COMPOSITE_SCORE_OUT_OF_RANGE", base));
  }

  if (score.compositeScore !== null && score.scoreBand !== null) {
    if (score.scoreBand !== expectedScoreBand(score.compositeScore)) {
      record(finding("REPUTATION_SCORE_BAND_MISMATCH", base));
    }
  }

  if (
    [score.fillRate7d, score.fillRate30d, score.fillRate90d].some((value) =>
      value !== null && (!Number.isFinite(value) || value < 0 || value > 1))
  ) {
    record(finding("REPUTATION_FILL_RATE_OUT_OF_RANGE", base));
  }

  if (
    percentileOutOfOrder(score.settleP50Ms, score.settleP95Ms) ||
    percentileOutOfOrder(score.slippageP50, score.slippageP95)
  ) {
    record(finding("REPUTATION_PERCENTILE_ORDER", base));
  }

  if (
    (score.settleP50Ms !== null && score.settleP50Ms < 0) ||
    (score.settleP95Ms !== null && score.settleP95Ms < 0)
  ) {
    record(finding("REPUTATION_DURATION_NEGATIVE", base));
  }
}

function auditDuplicateCorridorIdentities(
  corridors: readonly EvidenceIntegrityAuditSnapshot["corridors"][number][],
  record: (finding: EvidenceIntegrityFinding) => void,
): void {
  const seen = new Map<string, string>();
  for (const corridor of [...corridors].sort((left, right) =>
    compareText(left.id, right.id))) {
    const identity = corridorSemanticIdentity(corridor);
    if (identity === null) continue;
    const canonicalId = seen.get(identity);
    if (canonicalId !== undefined) {
      record(finding(
        "DUPLICATE_CORRIDOR_SEMANTIC_IDENTITY",
        entityBase("corridor", corridor.id, undefined, corridor.slug),
      ));
      continue;
    }
    seen.set(identity, corridor.id);
  }
}

function corridorSemanticIdentity(
  corridor: EvidenceIntegrityAuditSnapshot["corridors"][number],
): string | null {
  const values = [
    corridor.assetCodeFrom,
    corridor.countryFrom,
    corridor.assetCodeTo,
    corridor.countryTo,
  ];
  if (!values.every((value) => typeof value === "string" && value.length > 0)) {
    return null;
  }
  return values.map((value) => value.toUpperCase()).join("\0");
}

function finding(
  code: EvidenceIntegrityViolationCode,
  base: Omit<EvidenceIntegrityFinding, "code" | "remediation">,
): EvidenceIntegrityFinding {
  return Object.freeze({
    code,
    ...base,
    remediation: EVIDENCE_INTEGRITY_REMEDIATION[code],
  });
}

function entityBase(
  type: EvidenceIntegrityFinding["entity"]["type"],
  id: string,
  anchorSlug: string | undefined,
  corridorSlug: string | undefined,
): Omit<EvidenceIntegrityFinding, "code" | "remediation"> {
  return {
    entity: Object.freeze({ type, id }),
    ...(anchorSlug === undefined ? {} : { anchorSlug }),
    ...(corridorSlug === undefined ? {} : { corridorSlug }),
  };
}

function expectedScoreBand(score: number): EvidenceIntegrityScoreBand {
  if (score >= REPUTATION_BANDS.greenMinimum) return "GREEN";
  return score >= REPUTATION_BANDS.amberMinimum ? "AMBER" : "RED";
}

function percentileOutOfOrder(
  p50: number | null,
  p95: number | null,
): boolean {
  return p50 !== null && p95 !== null && p50 > p95;
}

function decimalSign(value: string): -1 | 0 | 1 | null {
  const trimmed = value.trim();
  if (!SIGNED_DECIMAL.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return -1;
  return parsed > 0 ? 1 : 0;
}

function membershipKey(anchorId: string, corridorId: string): string {
  return `${anchorId}\0${corridorId}`;
}

function compareFindings(
  left: EvidenceIntegrityFinding,
  right: EvidenceIntegrityFinding,
): number {
  return compareText(left.code, right.code)
    || compareText(left.entity.type, right.entity.type)
    || compareText(left.entity.id, right.entity.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
