export const RATE_FRESHNESS_THRESHOLD_MS = 120_000;
export const MIN_FRESH_SOURCES = 2;

/**
 * Cross-source anomaly criterion (issue #186). Peers must be captured within
 * this many milliseconds of the evaluated observation to count as
 * contemporaneous. It reuses the freshness threshold so the anomaly layer never
 * compares evidence the median itself would treat as belonging to another time.
 */
export const ANOMALY_CONTEMPORANEITY_WINDOW_MS = RATE_FRESHNESS_THRESHOLD_MS;
/**
 * Minimum number of independent contemporaneous peers that must agree with the
 * peer baseline before any observation can be declared anomalous. The evaluated
 * observation is never one of them.
 */
export const MIN_ANOMALY_PEERS = 2;
/**
 * Symmetric ratio tolerance in basis points: an observation is anomalous only
 * when max(rate, baseline) / min(rate, baseline) exceeds 1 + 2,000 bps (20%).
 * Deliberately wide so ordinary cross-anchor spread and fee differences never
 * trigger it; it targets gross errors such as decimal-scale or inverted pairs.
 * Exactly at the tolerance is not anomalous.
 */
export const ANOMALY_TOLERANCE_BPS = 2_000;
export const ANOMALY_CRITERION_VERSION = "peer-median-ratio-v1";
