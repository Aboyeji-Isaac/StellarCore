export const REPUTATION_OUTCOME_WINDOW_DAYS = 90;
export const REPUTATION_METRICS_WINDOW_DAYS = 30;
export const MIN_REPUTATION_OUTCOMES = 30;

export const REPUTATION_WEIGHTS = Object.freeze({
  availability: 20,
  rateFreshness: 15,
  coverage: 15,
  transferReliability: 50,
} as const);

export const REPUTATION_BANDS = Object.freeze({
  greenMinimum: 95,
  amberMinimum: 80,
} as const);

/**
 * Evidence-set manifest versioning and identity.
 *
 * Every persisted reputation evaluation writes exactly one immutable manifest
 * whose schema and reason-code vocabulary are versioned explicitly so an
 * archived manifest is never silently reinterpreted. Policy versions name the
 * exact scoring and freshness rules and the reviewed configuration revision in
 * force when the manifest was written.
 */
export const REPUTATION_EVIDENCE_MANIFEST_SCHEMA_VERSION = 1;
export const REPUTATION_REASON_CODE_VOCABULARY_VERSION = 1;
export const REPUTATION_SCORING_POLICY_VERSION = "reputation-scoring-v1";
export const REPUTATION_FRESHNESS_POLICY_VERSION = "rate-freshness-threshold-v1";
export const REPUTATION_CONFIGURATION_REVISION = "reviewed-configuration-v1";

/**
 * Upper bound on member rows serialized by the internal manifest inspection
 * path. The persisted manifest itself is never truncated; this bound keeps a
 * single operator read small and deterministic.
 */
export const MAX_REPUTATION_MANIFEST_INSPECTION_MEMBERS = 200;
