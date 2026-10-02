import { INTEGRITY_AUDIT_LIMITS } from "@/constants/integrity";
import { evaluateEvidenceIntegrity } from "@/lib/integrity/invariants";
import { EVIDENCE_INTEGRITY_REMEDIATION } from "@/lib/integrity/remediation";
import { PRISMA_EVIDENCE_INTEGRITY_REPOSITORY } from "@/lib/integrity/repository";
import type {
  EvidenceIntegrityAuditCounts,
  EvidenceIntegrityAuditDependencies,
  EvidenceIntegrityAuditLimits,
  EvidenceIntegrityAuditFailure,
  EvidenceIntegrityAuditOptions,
  EvidenceIntegrityAuditReport,
  EvidenceIntegrityAuditResult,
  EvidenceIntegrityAuditSnapshot,
} from "@/types/integrity";

/**
 * Runs one read-only integrity audit of the persisted evidence graph. The
 * default dependencies read a bounded snapshot through Prisma using only
 * `findMany` selects; callers may inject a repository for tests. The audit
 * never writes, updates, deletes, or opens a transaction, and it never mutates
 * the snapshot it evaluates.
 */
export async function runEvidenceIntegrityAudit(
  options: EvidenceIntegrityAuditOptions = {},
): Promise<EvidenceIntegrityAuditResult> {
  const observedAt = options.observedAt ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) {
    return failure("INVALID_AUDIT_TIME");
  }

  const limits: EvidenceIntegrityAuditLimits =
    options.limits ?? INTEGRITY_AUDIT_LIMITS;
  const dependencies: EvidenceIntegrityAuditDependencies =
    options.dependencies ?? PRISMA_EVIDENCE_INTEGRITY_REPOSITORY;

  try {
    const { snapshot, truncated: snapshotTruncated } =
      await dependencies.readSnapshot(limits);
    const evaluation = evaluateEvidenceIntegrity(snapshot, observedAt, limits);

    return Object.freeze({
      ok: true,
      generatedAt: observedAt.toISOString(),
      counts: countSnapshotRows(snapshot),
      truncated: snapshotTruncated || evaluation.suppressedFindingCount > 0,
      findingCount: evaluation.findingCount,
      suppressedFindingCount: evaluation.suppressedFindingCount,
      findings: evaluation.findings,
      remediationCatalog: remediationCatalog(),
    });
  } catch {
    return failure("SNAPSHOT_READ_FAILURE");
  }
}

function countSnapshotRows(
  snapshot: EvidenceIntegrityAuditSnapshot,
): EvidenceIntegrityAuditCounts {
  return Object.freeze({
    anchors: snapshot.anchors.length,
    corridors: snapshot.corridors.length,
    anchorCorridors: snapshot.anchorCorridors.length,
    rateSnapshots: snapshot.rateSnapshots.length,
    transferOutcomes: snapshot.transferOutcomes.length,
    reputationScores: snapshot.reputationScores.length,
  });
}

/**
 * Publishes the remediation catalog in deterministic code order so operators
 * and CI logs always see the same guidance for the same violation set.
 */
function remediationCatalog(): EvidenceIntegrityAuditReport["remediationCatalog"] {
  return Object.freeze(
    (Object.keys(EVIDENCE_INTEGRITY_REMEDIATION) as Array<
      keyof typeof EVIDENCE_INTEGRITY_REMEDIATION
    >)
      .sort(compareText)
      .map((code) =>
        Object.freeze({
          code,
          guidance: EVIDENCE_INTEGRITY_REMEDIATION[code],
        }),
      ),
  );
}

function failure(code: EvidenceIntegrityAuditFailure["code"]): EvidenceIntegrityAuditFailure {
  return Object.freeze({ ok: false, code });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
