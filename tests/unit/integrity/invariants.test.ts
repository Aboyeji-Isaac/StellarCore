import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRITY_AUDIT_LIMITS } from "@/constants/integrity";
import { evaluateEvidenceIntegrity } from "@/lib/integrity/invariants";
import type { EvidenceIntegrityAuditSnapshot } from "@/types/integrity";
import {
  NOW,
  VIOLATION_CASES,
  baseSnapshot,
  snapshotWith,
} from "./fixtures";

const LIMITS = INTEGRITY_AUDIT_LIMITS;

test("the clean baseline audits with zero findings", () => {
  const result = evaluateEvidenceIntegrity(baseSnapshot(), NOW, LIMITS);

  assert.equal(result.findingCount, 0);
  assert.equal(result.suppressedFindingCount, 0);
  assert.deepEqual([...result.findings], []);
});

test("every documented corruption class is detected", () => {
  for (const { code, snapshot } of VIOLATION_CASES) {
    const result = evaluateEvidenceIntegrity(snapshot, NOW, LIMITS);
    const detected = result.findings.some((finding) => finding.code === code);
    assert.equal(
      detected,
      true,
      `expected ${code} to be reported, got ${result.findings
        .map((finding) => finding.code)
        .join(", ") || "(none)"}`,
    );
  }
});

test("findings carry stable keys and remediation without evidence payloads", () => {
  const result = evaluateEvidenceIntegrity(baseSnapshot(), NOW, LIMITS);
  assert.equal(result.findingCount, 0);

  const { snapshot } = VIOLATION_CASES.find(({ code }) =>
    code === "RATE_SNAPSHOT_MEMBERSHIP_MISSING")!;
  const reported = evaluateEvidenceIntegrity(snapshot, NOW, LIMITS).findings;
  const finding = reported.find((entry) =>
    entry.code === "RATE_SNAPSHOT_MEMBERSHIP_MISSING");
  assert.ok(finding);
  assert.equal(finding.entity.type, "rate_snapshot");
  assert.equal(finding.entity.id, "rate-1");
  assert.equal(finding.anchorSlug, "anchor-a");
  assert.equal(finding.corridorSlug, "usdc-us-kes-ke");
  assert.equal(finding.remediation.length > 0, true);
  assert.equal(Object.isFrozen(finding), true);
  assert.equal(Object.isFrozen(finding.entity), true);

  const serialized = JSON.stringify(reported);
  for (const leaked of ["sourceAmount", "destinationAmount", "0.175", "17.5"]) {
    assert.equal(serialized.includes(leaked), false);
  }
});

test("detection is deterministic across repeated evaluations", () => {
  const { snapshot } = VIOLATION_CASES.find(({ code }) =>
    code === "REPUTATION_SCORE_BAND_MISMATCH")!;
  const first = evaluateEvidenceIntegrity(snapshot, NOW, LIMITS);
  const second = evaluateEvidenceIntegrity(snapshot, NOW, LIMITS);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("per-code findings are capped while the true count is preserved", () => {
  const overflowing: EvidenceIntegrityAuditSnapshot = snapshotWith({
    rateSnapshots: Array.from({ length: LIMITS.maxFindingsPerCode + 10 }, (_, index) =>
      Object.freeze({
        ...baseSnapshot().rateSnapshots[0]!,
        id: `rate-${String(index).padStart(4, "0")}`,
        sourceAmount: "0",
      })),
  });

  const result = evaluateEvidenceIntegrity(overflowing, NOW, LIMITS);
  assert.equal(result.findingCount, LIMITS.maxFindingsPerCode + 10);
  assert.equal(result.findings.length, LIMITS.maxFindingsPerCode);
  assert.equal(
    result.suppressedFindingCount,
    result.findingCount - result.findings.length,
  );
  assert.equal(
    result.findings.every((finding) =>
      finding.code === "RATE_SNAPSHOT_NON_POSITIVE_AMOUNT"),
    true,
  );
});

test("the overall finding cap bounds output across codes", () => {
  const snapshot = snapshotWith({
    rateSnapshots: [
      Object.freeze({ ...baseSnapshot().rateSnapshots[0]!, id: "r-fee", fee: "-1" }),
      Object.freeze({ ...baseSnapshot().rateSnapshots[0]!, id: "r-amount", rate: "0" }),
    ],
    transferOutcomes: [
      Object.freeze({ ...baseSnapshot().transferOutcomes[0]!, id: "o-neg", settlementMs: -1 }),
    ],
    reputationScores: [
      Object.freeze({ ...baseSnapshot().reputationScores[0]!, id: "s-band", scoreBand: "GREEN" as const }),
      Object.freeze({ ...baseSnapshot().reputationScores[0]!, id: "s-range", compositeScore: 150, scoreBand: "GREEN" as const }),
    ],
  });

  const result = evaluateEvidenceIntegrity(snapshot, NOW, {
    ...LIMITS,
    maxFindings: 3,
  });

  assert.equal(result.findings.length, 3);
  assert.equal(result.findingCount > 3, true);
  assert.equal(
    result.suppressedFindingCount,
    result.findingCount - result.findings.length,
  );
});

test("evaluation never mutates its input snapshot", () => {
  const snapshot = baseSnapshot();
  const before = JSON.stringify(snapshot);
  evaluateEvidenceIntegrity(snapshot, NOW, LIMITS);
  assert.equal(JSON.stringify(snapshot), before);
});
