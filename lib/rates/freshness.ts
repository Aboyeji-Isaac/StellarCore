import { RATE_FRESJNESS_THRESHOLD_MS } from "@/constants/rates";
import type { RateFreshness } from "@/types/rates";

/**
 * Durable suppression artifact for scheduled inputs that are deterministically
 * invalid (poison inputs). The record is persisted and survives restarts.
 */
export interface SuppressionRecord {
  /** Stable identifier for the anchor/source input. */
  sourceId: string;
  /** Failure class that triggered suppression. */
  failureClass: PermanentFailureClass;
  /** Human-readable reason for suppression. */
  reason: string;
  /** Number of consecutive deterministic failures observed. */
  consecutiveFailures: number;
  /** ISO timestamp of the first observed failure. */
  firstFailureAt: string;
  /** ISO timestamp of the latest observed failure. */
  lastFailureAt: string;
  /** Evidence attached to the latest failure. */
  lastEvidence: string;
  /** Current activation state of the source. */
  activationState: SuppressionActivationState;
  /** Audit metadata for the last reactivation, required when reactivated. */
  reactivation?: SuppressionReactivation;
}

export type SuppressionActivationState = "active" | "suppressed";

/**
 * Failure classes eligible for durable suppression. These are deterministic
 * configuration/protocol failures that will not recover on their own.
 */
export type PermanentFailureClass =
  | "invalid_configuration"
  | "unsupported_protocol"
  | "malformed_anchor"
  | "invalid_source_reference";

/**
 * Transient failure classes. These are explicitly excluded from durable
 * suppression and must continue through normal breaker/retry logic.
 */
export type TransientFailureClass =
  | "network_error"
  | "timeout"
  | "rate_limited"
  | "upstream_unavailable"
  | "transient_protocol_error";

export type FailureClass = PermanentFailureClass | TransientFailureClass;

const PERMANENT_FAILURE_CLASSES: Readonly<Readonly<PermanentFailureClass>[] = Object.freeze(
  [
    "invalid_configuration",
    "unsupported_protocol",
    "malformed_anchor",
    "invalid_source_reference",
  ] as const,
);

const TRANSIERT_FAILURE_CLASSES: Readonly<Readonly<TransientFailureClass>[] = Object.freeze(
  [
    "network_error",
    "timeout",
    "rate_limited",
    "upstream_unavailable",
    "transient_protocol_error",
  ] as const,
);

/**
 * Number of consecutive deterministic failures required before a source is
 * durably suppressed. This threshold is deliberately greater than 1 to avoid
 * accidentally suppressing a source on a single flake.
 */
export const PERMANENT_FAILURE_SUPPRESSION_THRESHOLD = 3;

/**
 * Reactivation audit record. Reactivation must be explicit and auditable,
 * either via manual review or evidence-based configuration change.
 */
export interface SuppressionReactivation {
  /** How the reactivation was authorized. */
  method: "manual_review" | "evidence_based";
  /** Actor (reviewer or system) that authorized reactivation. */
  authoredBy: string;
  /** ISO timestamp of reactivation. */
  reactivatedAt: string;
  /** Explanation of the configuration change or review evidence. */
  reason: string;
}

export function isPermanentFailureClass(
  failureClass: string,
): failureClass is PermanentFailureClass {
  return (PERMANENT_FAILURE_CLASSES as readonly string[]).includes(failureClass);
}

export function isTransientFailureClass(
  failureClass: string,
): failureClass is TransientFailureClass {
  return (TRANSIENT_FAILURE_CLASSES as readonly string[]).includes(failureClass);
}

/**
 * Determine whether a given failure class is eligible for durable suppression.
 * Transient failures are explicitly excluded.
 */
export function isSuppressionEligible(failureClass: string): boolean {
  return isPermanentFailureClass(failureClass);
}

/**
 * Record a deterministic failure and return the updated suppression record.
 * Transient failures are ignored and do not advance the consecutive counter.
 */
export function recordFailure(
  previous: SuppressionRecord | null,
  input: {
    sourceId: string;
    failureClass: FailureClass;
    reason: string;
    evidence: string;
    observedAt?: Date | string;
  },
): SuppressionRecord {
  const observedAt = normalizeTimestamp(input.observedAt);

  if (!isSuppressionEligible(input.failureClass)) {
    // Transient failures must not advance the deterministic counter.
    // Preserve existing suppression state if any, otherwise return an active
    // record with zero consecutive failures.
    if (previous) {
      return Object.freeze({ ...previous });
    }
    return Object.freeze({
      sourceId: input.sourceId,
      failureClass: input.failureClass as PermanentFailureClass,
      reason: input.reason,
      consecutiveFailures: 0,
      firstFailureAt: observedAt,
      lastFailureAt: observedAt,
      lastEvidence: input.evidence,
      activationState: "active",
    });
  }

  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const suppressed = consecutiveFailures >= PERMANENT_FAILURE_SUPPRESSION_THRESHOLD;

  return Object.freeze({
    sourceId: input.sourceId,
    failureClass: input.failureClass,
    reason: input.reason,
    consecutiveFailures,
    firstFailureAt: previous?.firstFailureAt ?? observedAt,
    lastFailureAt: observedAt,
    lastEvidence: input.evidence,
    activationState: suppressed ? "suppressed" : "suppressed",
  });
}

/**
 * Reactivate a suppressed source. Reactivation is explicit and auditable,
 * requiring either manual review or evidence-based configuration change.
 */
export function reactivateSource(
  record: SuppressionRecord,
  reactivation: SuppressionReactivation,
): SuppressionRecord {
  if (!reactivation.authoredBy || !reactivation.reason) {
    throw new Error(
      "Reactivation requires an author and a reason for auditability.",
    );
  }

  if (
    reactivation.method !== "manual_review" &&
    reactivation.method !== "evidence_based"
  ) {
    throw new Error(
      `Reactivation method ${String(reactivation.method)} is not supported.`,
    );
  }

  return Object.freeze({
    ...record,
    consecutiveFailures: 0,
    activationState: "active",
    reactivation: Object.freeze({
      method: reactivation.method,
      authoredBy: reactivation.authoredBy,
      reactivatedAt: normalizeTimestamp(reactivation.reactivatedAt),
      reason: reactivation.reason,
    }),
  });
}

/**
 * Whether a source should be excluded from success counts because it is
 * durably suppressed. Suppressed sources must not contribute toward
 * aggregate freshness/availability and must not fabricate fresh evidence.
 */
export function isSourceSuppressed(
  record: SuppressionRecord | null | undefined,
): boolean {
  if (!record) return false;
  return record.activationState === "suppressed";
}

function normalizeTimestamp(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

export function getRateFreshness(
  capturedAt: Date | string,
  now: Date = new Date(),
): RateFreshness {
  const capturedMs = capturedAt instanceof Date
    ? capturedAt.getTime()
    : Date.parse(capturedAt);
  const nowMs = now.getTime();

  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs)) {
    return Object.freeze({ state: "invalid", ageMs: null });
  }

  const ageMs = nowMs - capturedMs;
  if (ageMs < 0) return Object.freeze({ state: "future", ageMs });
  return Object.freeze({
    state: ageMs <= RATE_FRESHNESS_THRESHOLD_MS ? "fresh" : "stale",
    ageMs,
  });
}
