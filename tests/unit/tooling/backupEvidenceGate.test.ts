import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_EVIDENCE_MAX_AGE_MS,
  evaluateBackupEvidenceGate,
  type BackupEvidenceGateInput,
} from "@/lib/tooling/backupEvidenceGate";

// Fixed instant: staleness decisions are deterministic, never sleep-dependent.
const NOW = new Date("2026-10-20T12:00:00.000Z");
const TARGET_DB = "production:a6f2c1";
const OTHER_DB = "staging:9d4b71";
const HOUR_MS = 60 * 60 * 1000;

function gate(
  overrides: Partial<BackupEvidenceGateInput> = {},
) {
  return evaluateBackupEvidenceGate({
    risk: "HIGH",
    status: "PRESENT_SUCCESSFUL",
    completedAt: new Date(NOW.getTime() - HOUR_MS),
    targetDatabaseId: TARGET_DB,
    evidenceDatabaseId: TARGET_DB,
    now: () => NOW,
    ...overrides,
  });
}

test("valid recent evidence for the intended target passes a high-risk migration", () => {
  assert.deepEqual(gate(), { ok: true, reason: "EVIDENCE_VALID" });
  // Freshest possible evidence also passes.
  assert.deepEqual(gate({ completedAt: NOW }), { ok: true, reason: "EVIDENCE_VALID" });
});

test("missing backup evidence blocks a high-risk migration", () => {
  assert.deepEqual(gate({ status: "MISSING" }), {
    ok: false,
    code: "EVIDENCE_MISSING",
  });
  // A successful status with no recorded completion time is treated as missing.
  assert.deepEqual(gate({ completedAt: undefined }), {
    ok: false,
    code: "EVIDENCE_MISSING",
  });
  assert.deepEqual(gate({ completedAt: new Date(Number.NaN) }), {
    ok: false,
    code: "EVIDENCE_MISSING",
  });
});

test("failed backup evidence blocks a high-risk migration", () => {
  assert.deepEqual(gate({ status: "PRESENT_FAILED" }), {
    ok: false,
    code: "EVIDENCE_FAILED",
  });
});

test("stale backup evidence blocks a high-risk migration past the max age", () => {
  assert.deepEqual(gate({ completedAt: new Date(NOW.getTime() - BACKUP_EVIDENCE_MAX_AGE_MS - 1) }), {
    ok: false,
    code: "EVIDENCE_STALE",
  });
  assert.deepEqual(gate({ completedAt: new Date(NOW.getTime() - 2 * BACKUP_EVIDENCE_MAX_AGE_MS) }), {
    ok: false,
    code: "EVIDENCE_STALE",
  });
  // Exactly at the max age is still fresh (inclusive bound).
  assert.deepEqual(
    gate({ completedAt: new Date(NOW.getTime() - BACKUP_EVIDENCE_MAX_AGE_MS) }),
    { ok: true, reason: "EVIDENCE_VALID" },
  );
});

test("evidence bound to another database blocks a high-risk migration", () => {
  assert.deepEqual(
    gate({ evidenceDatabaseId: OTHER_DB }),
    { ok: false, code: "EVIDENCE_TARGET_MISMATCH" },
  );
  // No bound database at all is never treated as valid.
  assert.deepEqual(
    gate({ evidenceDatabaseId: undefined }),
    { ok: false, code: "EVIDENCE_TARGET_MISMATCH" },
  );
});

test("low-risk migration behavior remains unchanged and is never blocked", () => {
  assert.deepEqual(gate({ risk: "LOW", status: "MISSING" }), {
    ok: true,
    reason: "NOT_APPLICABLE_LOW_RISK",
  });
  assert.deepEqual(gate({ risk: "LOW", status: "PRESENT_FAILED" }), {
    ok: true,
    reason: "NOT_APPLICABLE_LOW_RISK",
  });
});

test("diagnostics avoid printing credentials or database URLs", () => {
  const leakedTarget = "postgresql://user:hunter2@prod:5432/db";
  const decision = gate({ targetDatabaseId: leakedTarget, evidenceDatabaseId: OTHER_DB });
  assert.equal(decision.ok, false);
  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("prod:5432"), false);
  assert.equal(serialized.includes("postgresql://"), false);

  const missing = gate({ status: "MISSING", targetDatabaseId: leakedTarget });
  assert.equal(missing.ok, false);
  assert.equal(JSON.stringify(missing).includes("hunter2"), false);
});
