import {
  ANOMALY_CONTEMPORANEITY_WINDOW_MS,
  ANOMALY_CRITERION_VERSION,
  ANOMALY_TOLERANCE_BPS,
  MIN_ANOMALY_PEERS,
} from "@/constants/rates";
import {
  averageDecimals,
  compareDecimals,
  formatDecimal,
  isZeroDecimal,
  parseDatabaseDecimal,
  type ExactDecimal,
} from "@/lib/rates/decimal";
import type {
  RateAnomalyAssessment,
  RateAnomalyObservation,
  RateAnomalyReason,
  RateAnomalyStatus,
} from "@/types/rates";

const BASIS_POINTS = BigInt(10_000);
const TEN = BigInt(10);

type ParsedObservation = Readonly<{
  source: RateAnomalyObservation;
  decimal: ExactDecimal;
  capturedMs: number;
}>;

/**
 * Deterministic cross-source anomaly criterion (issue #186).
 *
 * For each observation, its baseline is the median of the latest valid
 * observation from every *other* independence key captured within the
 * contemporaneity window of it. The evaluated observation and every other
 * observation sharing its independence key are excluded from its own baseline,
 * so no source can define the value it is judged against.
 *
 * - Fewer than MIN_ANOMALY_PEERS independent peers: insufficient_peers.
 * - Fewer than MIN_ANOMALY_PEERS peers within tolerance of the baseline (peers
 *   disagree among themselves): insufficient_peers / no_peer_consensus.
 * - Otherwise the observation is quarantined when the symmetric ratio between
 *   its rate and the baseline exceeds the tolerance, else consistent.
 *
 * The verdict depends only on the supplied evidence, never on input order or
 * wall-clock time.
 */
export function assessRateAnomalies(
  observations: readonly RateAnomalyObservation[],
): readonly RateAnomalyAssessment[] {
  const parsed = observations.map(parseObservation);
  return Object.freeze(observations.map((source, index) => {
    const subject = parsed[index];
    if (subject === "invalid_rate" || subject === "invalid_timestamp") {
      return assessment(source, "unassessable", subject, null, [], 0);
    }

    const peers = selectIndependentPeers(subject, parsed);
    if (peers.length < MIN_ANOMALY_PEERS) {
      return assessment(
        source,
        "insufficient_peers",
        "fewer_than_minimum_independent_peers",
        null,
        peers,
        0,
      );
    }

    const baseline = medianOf(peers.map(({ decimal }) => decimal));
    const agreeing = peers.filter(({ decimal }) => withinTolerance(decimal, baseline));
    if (agreeing.length < MIN_ANOMALY_PEERS) {
      return assessment(
        source,
        "insufficient_peers",
        "no_peer_consensus",
        baseline,
        peers,
        agreeing.length,
      );
    }

    return withinTolerance(subject.decimal, baseline)
      ? assessment(source, "consistent", null, baseline, peers, agreeing.length)
      : assessment(
        source,
        "quarantined",
        "deviates_from_peer_consensus",
        baseline,
        peers,
        agreeing.length,
      );
  }));
}

/**
 * True when max(left, right) / min(left, right) <= 1 + tolerance. Exact
 * integer arithmetic; the boundary itself is within tolerance.
 */
export function withinTolerance(
  left: ExactDecimal,
  right: ExactDecimal,
  toleranceBps: number = ANOMALY_TOLERANCE_BPS,
): boolean {
  const [low, high] = compareDecimals(left, right) <= 0 ? [left, right] : [right, left];
  const scale = Math.max(low.scale, high.scale);
  const lowValue = low.coefficient * TEN ** BigInt(scale - low.scale);
  const highValue = high.coefficient * TEN ** BigInt(scale - high.scale);
  return highValue * BASIS_POINTS <= lowValue * (BASIS_POINTS + BigInt(toleranceBps));
}

function parseObservation(
  source: RateAnomalyObservation,
): ParsedObservation | "invalid_rate" | "invalid_timestamp" {
  const capturedMs = source.capturedAt instanceof Date
    ? source.capturedAt.getTime()
    : Date.parse(source.capturedAt);
  if (!Number.isFinite(capturedMs)) return "invalid_timestamp";
  try {
    const decimal = parseDatabaseDecimal(source.rate);
    if (isZeroDecimal(decimal)) return "invalid_rate";
    return Object.freeze({ source, decimal, capturedMs });
  } catch {
    return "invalid_rate";
  }
}

/**
 * One peer per foreign independence key: the latest contemporaneous valid
 * observation, ties broken by the greater id (the selectLatestPerAnchor rule).
 */
function selectIndependentPeers(
  subject: ParsedObservation,
  parsed: readonly (ParsedObservation | "invalid_rate" | "invalid_timestamp")[],
): readonly ParsedObservation[] {
  const byKey = new Map<string, ParsedObservation>();
  for (const candidate of parsed) {
    if (typeof candidate === "string") continue;
    if (candidate.source.independenceKey === subject.source.independenceKey) continue;
    if (Math.abs(candidate.capturedMs - subject.capturedMs) > ANOMALY_CONTEMPORANEITY_WINDOW_MS) {
      continue;
    }
    const current = byKey.get(candidate.source.independenceKey);
    if (!current || isLater(candidate, current)) {
      byKey.set(candidate.source.independenceKey, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.source.independenceKey.localeCompare(right.source.independenceKey));
}

function isLater(left: ParsedObservation, right: ParsedObservation): boolean {
  if (left.capturedMs !== right.capturedMs) return left.capturedMs > right.capturedMs;
  return left.source.id > right.source.id;
}

function medianOf(values: readonly ExactDecimal[]): ExactDecimal {
  const sorted = [...values].sort(compareDecimals);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : averageDecimals(sorted[middle - 1]!, sorted[middle]!);
}

function assessment(
  source: RateAnomalyObservation,
  status: RateAnomalyStatus,
  reason: RateAnomalyReason | null,
  baseline: ExactDecimal | null,
  peers: readonly ParsedObservation[],
  agreeingPeerCount: number,
): RateAnomalyAssessment {
  return Object.freeze({
    observationId: source.id,
    independenceKey: source.independenceKey,
    status,
    reason,
    criterionVersion: ANOMALY_CRITERION_VERSION,
    baselineRate: baseline ? formatDecimal(baseline) : null,
    toleranceBps: ANOMALY_TOLERANCE_BPS,
    contemporaneityWindowMs: ANOMALY_CONTEMPORANEITY_WINDOW_MS,
    independentPeerCount: peers.length,
    agreeingPeerCount,
    peerObservationIds: Object.freeze(peers.map(({ source: peer }) => peer.id)),
  });
}
