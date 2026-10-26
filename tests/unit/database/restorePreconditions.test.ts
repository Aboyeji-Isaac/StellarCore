import assert from "node:assert/strict";
import test from "node:test";

import {
  type BackupVerificationEvidence,
  verifyRestorePreconditions,
} from "@/lib/database/restorePreconditions";

const VALID_EVIDENCE: BackupVerificationEvidence = Object.freeze({
  ok: true,
  backupId: "backup-20261021-001",
  checksum: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  verifiedAt: "2026-10-21T10:00:00.000Z",
  format: "custom",
  schemaVersion: "20261001123000",
});

test("restore is blocked when backup verification evidence is absent", () => {
  const resultNull = verifyRestorePreconditions(null, "staging");
  assert.equal(resultNull.ok, false);
  assert.equal(resultNull.canRestore, false);
  if (!resultNull.ok) {
    assert.equal(resultNull.code, "BACKUP_VERIFICATION_MISSING");
    assert.match(resultNull.reason, /evidence is absent/);
  }

  const resultUndefined = verifyRestorePreconditions(undefined, "test");
  assert.equal(resultUndefined.ok, false);
  if (!resultUndefined.ok) {
    assert.equal(resultUndefined.code, "BACKUP_VERIFICATION_MISSING");
  }
});

test("restore is blocked when backup verification reports failure and secrets are sanitized", () => {
  const failedEvidence: BackupVerificationEvidence = {
    ...VALID_EVIDENCE,
    ok: false,
    failureReason:
      "Corrupted checksum on chunk 4; attempted with key=aes256:super_secret_enc_key and postgresql://admin:secretPass@internal:5432/core",
  };

  const result = verifyRestorePreconditions(failedEvidence, "staging");
  assert.equal(result.ok, false);
  assert.equal(result.canRestore, false);
  if (!result.ok) {
    assert.equal(result.code, "BACKUP_VERIFICATION_FAILED");
    assert.match(result.reason, /backup verification failed/);
    assert.doesNotMatch(result.reason, /super_secret_enc_key/);
    assert.doesNotMatch(result.reason, /secretPass/);
    assert.match(result.reason, /\[REDACTED_SECRET\]|\[REDACTED_DATABASE_URL\]/);
  }
});

test("restore is blocked when backup format or schema version is incompatible", () => {
  const incompatibleFormat: BackupVerificationEvidence = {
    ...VALID_EVIDENCE,
    format: "plain",
  };

  const formatResult = verifyRestorePreconditions(incompatibleFormat, "staging", {
    supportedFormats: ["custom", "tar"],
  });
  assert.equal(formatResult.ok, false);
  if (!formatResult.ok) {
    assert.equal(formatResult.code, "BACKUP_INCOMPATIBLE");
    assert.match(formatResult.reason, /incompatible with the target restore runner/);
  }

  const incompatibleVersion: BackupVerificationEvidence = {
    ...VALID_EVIDENCE,
    schemaVersion: "20260801000000",
  };

  const versionResult = verifyRestorePreconditions(incompatibleVersion, "staging", {
    requiredSchemaVersion: "20261001123000",
  });
  assert.equal(versionResult.ok, false);
  if (!versionResult.ok) {
    assert.equal(versionResult.code, "BACKUP_INCOMPATIBLE");
    assert.match(versionResult.reason, /does not match required version/);
  }
});

test("restore directly targeting production is strictly forbidden", () => {
  const result = verifyRestorePreconditions(VALID_EVIDENCE, "production");
  assert.equal(result.ok, false);
  assert.equal(result.canRestore, false);
  if (!result.ok) {
    assert.equal(result.code, "PRODUCTION_RESTORE_BLOCKED");
    assert.match(result.reason, /Direct restore to production environment is forbidden/);
  }
});

test("valid verified backup follows restore execution path in isolated target environment", () => {
  const result = verifyRestorePreconditions(VALID_EVIDENCE, "isolated_restore_db");
  assert.equal(result.ok, true);
  assert.equal(result.canRestore, true);
  if (result.ok) {
    assert.equal(result.backupId, "backup-20261021-001");
    assert.equal(result.targetEnvironment, "isolated_restore_db");
    assert.equal(result.format, "custom");
  }
});
