/**
 * Restore preconditions and backup verification guards.
 *
 * Enforces the runbook policy in docs/backup-and-restore.md:
 * - A restore workflow must NEVER proceed when required backup integrity
 *   evidence is missing, failed, or incompatible.
 * - Restores must NEVER directly target a live production database.
 * - Diagnostics and failure reasons must NEVER expose encryption keys,
 *   passwords, tokens, or backup secrets.
 * - Valid, verified backups proceed cleanly to the restore execution path.
 */

export type BackupFormat = "custom" | "tar" | "directory" | "plain";

export type BackupVerificationEvidence = Readonly<{
  ok: boolean;
  backupId: string;
  checksum: string;
  verifiedAt: string;
  format: BackupFormat;
  schemaVersion?: string;
  failureReason?: string;
  // Metadata that might contain sensitive parameters to sanitize
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type RestorePreconditionResult =
  | Readonly<{
      ok: true;
      canRestore: true;
      backupId: string;
      targetEnvironment: string;
      format: BackupFormat;
    }>
  | Readonly<{
      ok: false;
      canRestore: false;
      code:
        | "BACKUP_VERIFICATION_MISSING"
        | "BACKUP_VERIFICATION_FAILED"
        | "BACKUP_INCOMPATIBLE"
        | "PRODUCTION_RESTORE_BLOCKED";
      reason: string;
    }>;

/**
 * Sanitizes a reason or message string so credentials and secrets are stripped.
 */
export function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/(?:postgresql|postgres):\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(?:bearer|token|key|secret|passphrase)=\S+/gi, "[REDACTED_SECRET]");
}

/**
 * Verifies all restore preconditions prior to starting a database restore.
 */
export function verifyRestorePreconditions(
  backupEvidence: BackupVerificationEvidence | null | undefined,
  targetEnvironment: string,
  options: Readonly<{
    supportedFormats?: readonly BackupFormat[];
    requiredSchemaVersion?: string;
  }> = {},
): RestorePreconditionResult {
  // 1. Guard against direct restores to production
  if (targetEnvironment.toLowerCase() === "production") {
    return Object.freeze({
      ok: false,
      canRestore: false,
      code: "PRODUCTION_RESTORE_BLOCKED",
      reason:
        "Direct restore to production environment is forbidden. Restores must target an isolated fresh database first per docs/backup-and-restore.md.",
    });
  }

  // 2. Guard against missing verification evidence
  if (!backupEvidence) {
    return Object.freeze({
      ok: false,
      canRestore: false,
      code: "BACKUP_VERIFICATION_MISSING",
      reason: "Restore blocked: required backup verification evidence is absent.",
    });
  }

  // 3. Guard against failed verification
  if (!backupEvidence.ok) {
    const rawReason = backupEvidence.failureReason ?? "Integrity check failed";
    return Object.freeze({
      ok: false,
      canRestore: false,
      code: "BACKUP_VERIFICATION_FAILED",
      reason: `Restore blocked: backup verification failed (${sanitizeDiagnosticMessage(rawReason)}).`,
    });
  }

  // 4. Guard against incompatible backup formats or versions
  const supported = options.supportedFormats ?? ["custom", "tar"];
  if (!supported.includes(backupEvidence.format)) {
    return Object.freeze({
      ok: false,
      canRestore: false,
      code: "BACKUP_INCOMPATIBLE",
      reason: `Restore blocked: backup format '${backupEvidence.format}' is incompatible with the target restore runner.`,
    });
  }

  if (
    options.requiredSchemaVersion &&
    backupEvidence.schemaVersion &&
    backupEvidence.schemaVersion !== options.requiredSchemaVersion
  ) {
    return Object.freeze({
      ok: false,
      canRestore: false,
      code: "BACKUP_INCOMPATIBLE",
      reason: `Restore blocked: backup schema version '${backupEvidence.schemaVersion}' does not match required version '${options.requiredSchemaVersion}'.`,
    });
  }

  return Object.freeze({
    ok: true,
    canRestore: true,
    backupId: backupEvidence.backupId,
    targetEnvironment,
    format: backupEvidence.format,
  });
}
