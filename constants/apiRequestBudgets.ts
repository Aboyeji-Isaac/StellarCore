/**
 * End-to-end budgets for public read routes, measured from handler entry until
 * the response is produced. They bound the total work of an admitted request
 * and sit above the independently configurable PostgreSQL pool, acquisition,
 * and statement budgets, which they never replace or bypass.
 *
 * Every value stays well below the hosting platform's request limit so an
 * expired budget is reported by StellarCore instead of being cut off mid-write.
 */
export const PUBLIC_API_REQUEST_BUDGETS_MS = Object.freeze({
  /** Full anchor directory with junction counts. */
  anchorList: 4_000,
  /** One anchor with its reviewed corridor relationships. */
  anchorDetail: 2_500,
  /** Full corridor directory with membership counts. */
  corridorList: 4_000,
  /** One corridor with its member anchors. */
  corridorDetail: 2_500,
  /** Two sequential reads, including a per-anchor latest-observation aggregate. */
  rateObservations: 5_000,
  /** Full reputation list joined to current scores. */
  reputationList: 4_000,
  /** One anchor joined to its current reputation score. */
  reputationDetail: 2_500,
} as const);

export type PublicApiRequestBudgetRoute =
  keyof typeof PUBLIC_API_REQUEST_BUDGETS_MS;
