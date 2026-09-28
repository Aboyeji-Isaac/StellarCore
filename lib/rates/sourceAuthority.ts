import { getRateFreshness } from "@/lib/rates/freshness";
import type { LatestRateRepositoryObservation } from "@/types/latestRates";
import type { RateFreshnessState } from "@/types/rates";

/**
 * Reviewed authority identifiers are opaque and assigned once at review time.
 * The pattern deliberately rejects anything name-, host-, or slug-derived so
 * that a display-text rename cannot silently mint a new independent authority.
 */
const SOURCE_AUTHORITY_ID_PATTERN = /^auth-[0-9]{4}$/;

const MAX_DISPLAY_NAME_LENGTH = 120;

export function isValidSourceAuthorityId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_AUTHORITY_ID_PATTERN.test(value);
}

export function isValidAuthorityConfigurationVersion(
  value: unknown,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

export function isValidAuthorityDisplayName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_DISPLAY_NAME_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export type AuthorityObservationExclusionReason =
  | "unknown_authority"
  | "correlated_same_authority";

export type AuthorityObservationExclusion = Readonly<{
  observation: LatestRateRepositoryObservation;
  reason: AuthorityObservationExclusionReason;
}>;

export type IndependentAuthoritySelection = Readonly<{
  /**
   * At most one deterministic representative per reviewed authority. The
   * persisted authority identity is authoritative for counting: current
   * reviewed configuration is never consulted to reclassify history.
   */
  selected: readonly LatestRateRepositoryObservation[];
  /** Correlated or unattributable observations, retained with a reason. */
  exclusions: readonly AuthorityObservationExclusion[];
  independentAuthorityCount: number;
}>;

/**
 * Freshness is preferred first so one fresh observation among several
 * correlated observations still represents the authority, then capture order,
 * then the stable snapshot id. Correlated observations are never averaged.
 */
const FRESHNESS_RANK: Readonly<Record<RateFreshnessState, number>> = Object.freeze({
  fresh: 0,
  stale: 1,
  future: 2,
  invalid: 3,
});

/**
 * Collapses latest-per-anchor observations into at most one observation per
 * reviewed authority. Observations without a valid persisted authority
 * identity are excluded as `unknown_authority` — missing or ambiguous evidence
 * reduces the eligible independent count instead of being guessed — and every
 * other observation that shares an authority with the chosen representative is
 * excluded as `correlated_same_authority`.
 */
export function selectIndependentAuthorityObservations(
  observations: readonly LatestRateRepositoryObservation[],
  now: Date = new Date(),
): IndependentAuthoritySelection {
  const representatives = new Map<string, LatestRateRepositoryObservation>();
  const exclusions: AuthorityObservationExclusion[] = [];

  for (const observation of observations) {
    if (!isValidSourceAuthorityId(observation.authorityId)) {
      exclusions.push(freezeExclusion(observation, "unknown_authority"));
      continue;
    }

    const current = representatives.get(observation.authorityId);
    if (current && compareRepresentatives(observation, current, now) <= 0) {
      exclusions.push(freezeExclusion(observation, "correlated_same_authority"));
      continue;
    }
    if (current) {
      exclusions.push(freezeExclusion(current, "correlated_same_authority"));
    }
    representatives.set(observation.authorityId, observation);
  }

  const selected = Object.freeze(
    [...representatives.values()].sort((left, right) =>
      compareText(left.authorityId ?? "", right.authorityId ?? "")),
  );

  return Object.freeze({
    selected,
    exclusions: Object.freeze(exclusions),
    independentAuthorityCount: selected.length,
  });
}

/** Positive when `left` should represent the authority over `right`. */
function compareRepresentatives(
  left: LatestRateRepositoryObservation,
  right: LatestRateRepositoryObservation,
  now: Date,
): number {
  const leftRank = FRESHNESS_RANK[getRateFreshness(left.capturedAt, now).state];
  const rightRank = FRESHNESS_RANK[getRateFreshness(right.capturedAt, now).state];
  if (leftRank !== rightRank) return leftRank < rightRank ? 1 : -1;

  const leftTime = timestampValue(left.capturedAt);
  const rightTime = timestampValue(right.capturedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;

  return compareText(left.id, right.id);
}

function timestampValue(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeExclusion(
  observation: LatestRateRepositoryObservation,
  reason: AuthorityObservationExclusionReason,
): AuthorityObservationExclusion {
  return Object.freeze({ observation, reason });
}
