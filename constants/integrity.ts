import type { EvidenceIntegrityAuditLimits } from "@/types/integrity";

/**
 * Bounds for the read-only evidence-graph integrity audit. The audit loads at
 * most this many rows from the high-volume evidence tables and reports at most
 * this many findings so the output stays safe for CI and operator logs.
 */
export const INTEGRITY_AUDIT_LIMITS: EvidenceIntegrityAuditLimits = Object.freeze({
  maxRowsPerHighVolumeTable: 5_000,
  maxFindingsPerCode: 50,
  maxFindings: 200,
  futureTimestampToleranceMs: 5 * 60 * 1_000,
});
