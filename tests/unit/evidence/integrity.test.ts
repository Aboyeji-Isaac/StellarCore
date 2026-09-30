import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTransferOutcome,
  isValidInstant,
  MAX_REPORTED_INTEGRITY_ISSUES,
  reportEvidenceIntegrityIssues,
  setEvidenceIntegritySink,
  type EvidenceIntegrityEvent,
  type EvidenceIntegrityIssue,
} from "@/lib/evidence/integrity";

const VALID = { settlementMs: 1_000, slippage: 0.01, recordedAt: new Date("2026-09-01T00:00:00Z") };

test("a clean transfer outcome is not classified as corrupt", () => {
  assert.equal(classifyTransferOutcome(VALID), null);
  assert.equal(classifyTransferOutcome({ ...VALID, settlementMs: 0, slippage: -0.5 }), null);
});

test("each corruption class is detected and never normalized", () => {
  assert.equal(classifyTransferOutcome({ ...VALID, recordedAt: new Date(NaN) }), "INVALID_TIMESTAMP");
  assert.equal(classifyTransferOutcome({ ...VALID, slippage: NaN }), "INVALID_NUMBER");
  assert.equal(classifyTransferOutcome({ ...VALID, slippage: Infinity }), "INVALID_NUMBER");
  assert.equal(classifyTransferOutcome({ ...VALID, settlementMs: 1.5 }), "INVALID_NUMBER");
  assert.equal(classifyTransferOutcome({ ...VALID, settlementMs: -1 }), "OUT_OF_RANGE");
});

test("instants accept valid dates and strings and reject everything else", () => {
  assert.equal(isValidInstant(new Date()), true);
  assert.equal(isValidInstant("2026-09-01T00:00:00Z"), true);
  assert.equal(isValidInstant(new Date(NaN)), false);
  assert.equal(isValidInstant("not a date"), false);
  assert.equal(isValidInstant(null), false);
  assert.equal(isValidInstant(undefined), false);
});

test("reports are typed, bounded, and carry identifiers only", () => {
  const events: EvidenceIntegrityEvent[] = [];
  const previous = setEvidenceIntegritySink((event) => events.push(event));
  try {
    const issues: EvidenceIntegrityIssue[] = Array.from({ length: 50 }, (_, index) => ({
      source: "transfer_outcome",
      class: "OUT_OF_RANGE",
      recordId: `id-${index}`,
      anchorSlug: "anchor",
      corridorSlug: "corridor",
    }));
    reportEvidenceIntegrityIssues(issues, 500);
    reportEvidenceIntegrityIssues([], 0);
  } finally {
    setEvidenceIntegritySink(previous);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "evidence_integrity");
  assert.equal(events[0]!.total, 500);
  assert.equal(events[0]!.issues.length, MAX_REPORTED_INTEGRITY_ISSUES);
  assert.deepEqual(Object.keys(events[0]!.issues[0]!).sort(), [
    "anchorSlug", "class", "corridorSlug", "recordId", "source",
  ]);
});

test("a failing diagnostics sink never breaks the caller", () => {
  const previous = setEvidenceIntegritySink(() => { throw new Error("sink down"); });
  try {
    assert.doesNotThrow(() => reportEvidenceIntegrityIssues([{ source: "anchor", class: "OUT_OF_RANGE" }]));
  } finally {
    setEvidenceIntegritySink(previous);
  }
});
