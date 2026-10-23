import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRITY_AUDIT_LIMITS } from "@/constants/integrity";
import { runEvidenceIntegrityAudit } from "@/lib/integrity/audit";
import type {
  EvidenceIntegrityAuditDependencies,
  EvidenceIntegrityAuditReadResult,
  EvidenceIntegrityAuditSnapshot,
} from "@/types/integrity";
import { NOW, baseSnapshot, snapshotWith } from "./fixtures";

function repository(
  snapshot: EvidenceIntegrityAuditSnapshot,
  truncated = false,
): Readonly<{
  dependencies: EvidenceIntegrityAuditDependencies;
  calls: Array<Readonly<{ limit: number }>>;
}> {
  const calls: Array<Readonly<{ limit: number }>> = [];
  const dependencies: EvidenceIntegrityAuditDependencies = {
    readSnapshot: async (limits) => {
      calls.push(Object.freeze({ limit: limits.maxRowsPerHighVolumeTable }));
      const result: EvidenceIntegrityAuditReadResult = Object.freeze({
        snapshot,
        truncated,
      });
      return result;
    },
  };
  return Object.freeze({ dependencies, calls });
}

test("a clean snapshot produces a bounded zero-finding report", async () => {
  const { dependencies, calls } = repository(baseSnapshot());
  const result = await runEvidenceIntegrityAudit({
    dependencies,
    observedAt: NOW,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.generatedAt, NOW.toISOString());
  assert.deepEqual({ ...result.counts }, {
    anchors: 1,
    corridors: 2,
    anchorCorridors: 1,
    rateSnapshots: 1,
    transferOutcomes: 1,
    reputationScores: 1,
  });
  assert.equal(result.truncated, false);
  assert.equal(result.findingCount, 0);
  assert.equal(result.suppressedFindingCount, 0);
  assert.equal(result.findings.length, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.counts), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.limit, INTEGRITY_AUDIT_LIMITS.maxRowsPerHighVolumeTable);
});

test("the remediation catalog is deterministic and covers every class", async () => {
  const { dependencies } = repository(baseSnapshot());
  const result = await runEvidenceIntegrityAudit({ dependencies, observedAt: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const codes = result.remediationCatalog.map((entry) => entry.code);
  assert.ok(codes.length > 0);
  assert.deepEqual(codes, [...codes].sort());
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes("RATE_SNAPSHOT_MEMBERSHIP_MISSING"));
  assert.equal(Object.isFrozen(result.remediationCatalog), true);
  assert.equal(Object.isFrozen(result.remediationCatalog[0]), true);
});

test("findings and snapshot truncation mark the report as truncated", async () => {
  const snapshot = snapshotWith({
    rateSnapshots: Array.from({ length: 10 }, (_, index) =>
      Object.freeze({
        ...baseSnapshot().rateSnapshots[0]!,
        id: `rate-${index}`,
        rate: "0",
      }),
    ),
  });
  const { dependencies } = repository(snapshot, true);
  const result = await runEvidenceIntegrityAudit({
    dependencies,
    observedAt: NOW,
    limits: { ...INTEGRITY_AUDIT_LIMITS, maxFindings: 2, maxFindingsPerCode: 2 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.truncated, true);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findingCount, 10);
  assert.equal(result.suppressedFindingCount, 8);
});

test("auditing never mutates the snapshot it reads", async () => {
  const snapshot = baseSnapshot();
  const { dependencies } = repository(snapshot);
  const before = JSON.stringify(snapshot);
  await runEvidenceIntegrityAudit({ dependencies, observedAt: NOW });
  assert.equal(JSON.stringify(snapshot), before);
});

test("invalid audit times short-circuit before any snapshot read", async () => {
  const { dependencies, calls } = repository(baseSnapshot());
  const result = await runEvidenceIntegrityAudit({
    dependencies,
    observedAt: new Date("invalid"),
  });
  assert.deepEqual(result, { ok: false, code: "INVALID_AUDIT_TIME" });
  assert.equal(calls.length, 0);
});

test("snapshot read failures expose only a safe code", async () => {
  const result = await runEvidenceIntegrityAudit({
    observedAt: NOW,
    dependencies: {
      readSnapshot: async () => {
        throw new Error("postgres://user:secret@host/db");
      },
    },
  });

  assert.deepEqual(result, { ok: false, code: "SNAPSHOT_READ_FAILURE" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
