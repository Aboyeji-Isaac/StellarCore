/**
 * Backup restore key-resolution policy (issue #352).
 *
 * Issue #216 requires backups to remain restorable during a planned
 * encryption-key rotation and after the old key is retired. This module is the
 * pure decision logic for that overlap: it decides which supported key may
 * decrypt a given artifact and produces deterministic, non-secret diagnostics.
 *
 * Design rules:
 * - A backup artifact carries a `keyId` (identifier only, never key material).
 * - Restore first tries the current key, then, while the documented overlap
 *   window is active, the previous (outgoing) key.
 * - Unknown or retired key IDs fail closed with a stable, actionable code that
 *   does not echo credentials, key material, or database URLs.
 * - Key identifiers may be logged; key material never crosses this boundary.
 *
 * This module performs no I/O and contains no real secrets. It is the seam the
 * actual restore tooling calls; the tooling owns decryption and file I/O.
 */
export const BACKUP_KEY_OVERLAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type BackupKeyIdentity = Readonly<{
  /** Public key identifier, safe to log. */
  keyId: string;
}>;

export type ResolveRestoreKeyDecision =
  | Readonly<{
      ok: true;
      /** The key whose identifier matched the artifact, in verification order. */
      keyId: string;
      /** Which key slot matched, so operators can distinguish overlap restores. */
      slot: "primary" | "overlap";
    }>
  | Readonly<{
      ok: false;
      code:
        | "ARTIFACT_KEY_MISSING"
        | "ARTIFACT_KEY_EMPTY"
        | "KEY_UNKNOWN"
        | "KEY_RETIRED"
        | "NO_SUPPORTED_KEYS";
      /** Identifier of the artifact's key when it is well-formed (safe to log). */
      artifactKeyId: string | null;
    }>;

export type ResolveRestoreKeyInput = Readonly<{
  artifactKeyId: string | undefined;
  currentKey: BackupKeyIdentity | undefined;
  previousKey: BackupKeyIdentity | undefined;
  /** Rotation overlap deadline; the previous key only decrypts before this. */
  overlapUntil: Date | undefined;
  now: () => Date;
}>;

/**
 * Resolves which currently supported key may open a backup artifact.
 * Fails closed on missing, blank, unknown, or retired key identifiers.
 */
export function resolveRestoreKey(
  input: ResolveRestoreKeyInput,
): ResolveRestoreKeyDecision {
  const artifactKeyId = normalizeIdentifier(input.artifactKeyId);
  if (input.artifactKeyId === undefined) {
    return Object.freeze({ ok: false, code: "ARTIFACT_KEY_MISSING", artifactKeyId: null });
  }
  if (artifactKeyId === null) {
    return Object.freeze({ ok: false, code: "ARTIFACT_KEY_EMPTY", artifactKeyId: null });
  }

  const currentKeyId = input.currentKey
    ? normalizeIdentifier(input.currentKey.keyId)
    : null;
  if (currentKeyId === null) {
    return Object.freeze({ ok: false, code: "NO_SUPPORTED_KEYS", artifactKeyId });
  }

  if (artifactKeyId === currentKeyId) {
    return Object.freeze({ ok: true, keyId: artifactKeyId, slot: "primary" });
  }

  const previousKeyId = input.previousKey
    ? normalizeIdentifier(input.previousKey.keyId)
    : null;
  if (previousKeyId !== null) {
    const overlapActive = overlapIsActive(input.overlapUntil, input.now());
    if (overlapActive && artifactKeyId === previousKeyId) {
      return Object.freeze({ ok: true, keyId: artifactKeyId, slot: "overlap" });
    }
    // The artifact names a key we once supported but whose slot has been
    // retired (no window, or the window has closed): fail closed.
    if (artifactKeyId === previousKeyId) {
      return Object.freeze({ ok: false, code: "KEY_RETIRED", artifactKeyId });
    }
  }

  return Object.freeze({ ok: false, code: "KEY_UNKNOWN", artifactKeyId });
}

function overlapIsActive(overlapUntil: Date | undefined, now: Date): boolean {
  if (overlapUntil === undefined) return false;
  const deadline = overlapUntil.getTime();
  return Number.isFinite(deadline) && now.getTime() < deadline;
}

function normalizeIdentifier(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Bounded identifier surface: safe to log, never treated as a secret.
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}
