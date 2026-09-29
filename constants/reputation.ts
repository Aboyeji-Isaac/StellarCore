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
 * Policy version identifier for the current reputation policy.
 *
 * This value is persisted alongside every reputation evaluation so that
 * historical replay verification can re-run the exact policy that originally
 * produced the stored result. Never substitute the current policy for a
* different historical policy version during replay.
 */
export const CURRENT_REPUTATION_POLICY_VERSION = 1;

/**
 * All reputation policy versions that this build knows how to execute
 * deterministically. Replay of an evaluation whose policy version is not in
 * this set must fail closed rather than silently running the current policy.
 */
export const SUPPORTED_REPUTATION_POLICY_VERSIONS: readonly number[] =
  Object.freeze([1]);

export function isSupportedReputationPolicyVersion(version: number): boolean {
  return SUPPORTED_REPUTATION_POLICY_VERSIONS.includes(version);
}
