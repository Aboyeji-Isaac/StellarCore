/**
 * Backup-evidence gate for production migrations (issue #353).
 *
 * Issue #188 requires high-risk production migrations to be blocked when
 * backup evidence is absent, stale, unsuccessful, or bound to another
 * database. This module is the pure decision logic for that gate; the
 * migration workflow calls it with synthetic metadata before any mutate step.
 *
 * The gate never sees credentials: the input is metadata about the backup
 * artifact (freshness, previous run result, target database identity), not the
 * artifact or the connection string itself. Diagnostics therefore never
 * contain database URLs or passwords.
 *
 * Policy:
 * - Risk is classified LOW or HIGH by the existing risk-classification policy;
 *   the gate only blocks HIGH-risk migrations.
 * - A HIGH-risk migration passes only when evidence is present, fresh (within
 *   `maxAgeMs`), successful, and bound to the intended target identity.
 * - Any other combination (missing, stale, failed, or mismatched) fails closed
 *   with a stable, secret-free code.
 * - LOW-risk migrations are unaffected by the gate (behavior unchanged).
 */
export const BACKUP_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export type BackupEvidenceStatus =
  | "PRESENT_SUCCESSFUL"
  | "PRESENT_FAILED"
  | "MISSING";

export type MigrationRisk = "LOW" | "HIGH";

export type BackupEvidenceGateInput = Readonly<{
  risk: MigrationRisk;
  status: BackupEvidenceStatus;
  completedAt: Date | undefined;
  targetDatabaseId: string;
  evidenceDatabaseId: string | undefined;
  now: () => Date;
  maxAgeMs?: number;
}>;

export type BackupEvidenceGateDecision =
  | Readonly<{ ok: true; reason: "NOT_APPLICABLE_LOW_RISK" | "EVIDENCE_VALID" }>
  | Readonly<{
      ok: false;
      code:
        | "EVIDENCE_MISSING"
        | "EVIDENCE_FAILED"
        | "EVIDENCE_STALE"
        | "EVIDENCE_TARGET_MISMATCH";
    }>;

export function evaluateBackupEvidenceGate(
  input: BackupEvidenceGateInput,
): BackupEvidenceGateDecision {
  if (input.risk === "LOW") {
    // Low-risk behavior is intentionally unchanged by the gate.
    return Object.freeze({ ok: true, reason: "NOT_APPLICABLE_LOW_RISK" });
  }

  if (input.status === "MISSING") {
    return Object.freeze({ ok: false, code: "EVIDENCE_MISSING" });
  }
  if (input.status === "PRESENT_FAILED") {
    return Object.freeze({ ok: false, code: "EVIDENCE_FAILED" });
  }

  const completedAt = input.completedAt?.getTime();
  if (completedAt === undefined || !Number.isFinite(completedAt)) {
    return Object.freeze({ ok: false, code: "EVIDENCE_MISSING" });
  }

  const maxAgeMs = input.maxAgeMs ?? BACKUP_EVIDENCE_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    return Object.freeze({ ok: false, code: "EVIDENCE_STALE" });
  }

  const currentAgeMs = input.now().getTime() - completedAt;
  if (!Number.isFinite(currentAgeMs) || currentAgeMs > maxAgeMs) {
    return Object.freeze({ ok: false, code: "EVIDENCE_STALE" });
  }

  if (input.evidenceDatabaseId !== input.targetDatabaseId) {
    return Object.freeze({ ok: false, code: "EVIDENCE_TARGET_MISMATCH" });
  }

  return Object.freeze({ ok: true, reason: "EVIDENCE_VALID" });
}
