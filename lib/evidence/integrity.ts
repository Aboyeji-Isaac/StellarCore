/**
 * Runtime containment for persisted evidence that violates application-level
 * expectations (corrupt legacy rows, or rows altered outside the application).
 *
 * A record that fails validation is excluded from the read that found it; it is
 * never coerced into a plausible value. What is reported about it is limited to
 * a typed class and stable identifiers, never row contents.
 */
export type EvidenceCorruptionClass =
  | "INVALID_TIMESTAMP"
  | "INVALID_NUMBER"
  | "OUT_OF_RANGE";

export type EvidenceSource =
  | "rate_snapshot"
  | "transfer_outcome"
  | "reputation_score"
  | "anchor";

export type EvidenceIntegrityIssue = Readonly<{
  source: EvidenceSource;
  class: EvidenceCorruptionClass;
  recordId?: string;
  anchorSlug?: string;
  corridorSlug?: string;
}>;

export type EvidenceIntegrityEvent = Readonly<{
  event: "evidence_integrity";
  total: number;
  issues: readonly EvidenceIntegrityIssue[];
}>;

export type EvidenceIntegritySink = (event: EvidenceIntegrityEvent) => void;

/** Upper bound on issues carried in one event, however much is corrupt. */
export const MAX_REPORTED_INTEGRITY_ISSUES = 20;

let sink: EvidenceIntegritySink = (event) => {
  console.warn(JSON.stringify(event));
};

/** Replaces the diagnostics sink and returns the previous one. */
export function setEvidenceIntegritySink(
  next: EvidenceIntegritySink,
): EvidenceIntegritySink {
  const previous = sink;
  sink = next;
  return previous;
}

/**
 * Emits one bounded diagnostic event. `total` is the number of corrupt records
 * found, which may exceed the identifiers listed. A failing sink never affects
 * the read that produced the issues.
 */
export function reportEvidenceIntegrityIssues(
  issues: readonly EvidenceIntegrityIssue[],
  total: number = issues.length,
): void {
  if (total <= 0) return;
  try {
    sink(Object.freeze({
      event: "evidence_integrity",
      total,
      issues: Object.freeze(issues.slice(0, MAX_REPORTED_INTEGRITY_ISSUES)),
    }));
  } catch {
    // Diagnostics must not turn contained corruption into a failed request.
  }
}

export function isValidInstant(value: Date | string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds);
}

export function classifyTransferOutcome(outcome: Readonly<{
  settlementMs: number;
  slippage: number;
  recordedAt: Date;
}>): EvidenceCorruptionClass | null {
  if (!isValidInstant(outcome.recordedAt)) return "INVALID_TIMESTAMP";
  if (!Number.isInteger(outcome.settlementMs) || !Number.isFinite(outcome.slippage)) {
    return "INVALID_NUMBER";
  }
  if (outcome.settlementMs < 0) return "OUT_OF_RANGE";
  return null;
}
