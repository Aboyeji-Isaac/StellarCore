import { createHash } from "node:crypto";

/**
 * Deterministic replay verification for historical reputation evaluations.
 *
 * This module is read-only and offline. It never consults live registry state,
 * never issues SEP requests, and never writes back to any store.
 */

// -----------------------------------------------------------------------------
// Public types

/** Band classification for a reputation score. */
export type ReputationBand = "UNTRUSTED" | "LOW" | "MEDIUM" | "HIGH";

/** A single component contribution to a reputation score. */
export interface ReputationComponent {
  readonly name: string;
  readonly weight: string; // decimal as string
  readonly value: string; // decimal as string
  readonly contribution: string; // decimal as string
}

/** Numeric metrics recorded during an evaluation. */
export interface ReputationMetrics {
  readonly totalTrustedTransferOutcomes: number;
  readonly successfulTransferOutcomes: number;
  readonly failedTransferOutcomes: number;
  readonly disputeCount: number;
  readonly ageDays: number;
}

/** A historical reputation evaluation as persisted by #114. */
export interface ReputationEvaluation {
  readonly evaluationId: string;
  readonly subjectId: string;
  readonly policyVersion: string;
  readonly state: string;
  readonly score: string; // decimal as string
  readonly band: ReputationBand;
  readonly components: readonly ReputationComponent[];
  readonly metrics: ReputationMetrics;
  readonly counts: Readonly<Record<string, number>>;
  readonly evaluatedAt: string; // ISO-8601 UTC timestamp
}

/**
 * Immutable evidence manifest as recorded by #134.
 * The manifest captures the exact input membership used to produce an evaluation.
 */
export interface EvidenceManifest {
  readonly manifestId: string;
  readonly evaluationId: string;
  readonly policyVersion: string;
  /** Ordered list of evidence record ids that were considered. */
  readonly evidenceIds: readonly string[];
  /** Content hash of the canonicalized evidence set. */
  readonly evidenceHash: string;
  /** Whether the manifest was captured at evaluation time. */
  readonly capturedAt: string;
}

/** A single immutable evidence record referenced by a manifest. */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly kind: "transfer_outcome" | "dispute" | "account_age" | "provenance_rate";
  readonly subjectId: string;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The result of running a policy version over a reconstructed input. */
export interface PolicyExecutionResult {
  readonly state: string;
  readonly score: string;
  readonly band: ReputationBand;
  readonly components: readonly ReputationComponent[];
  readonly metrics: ReputationMetrics;
  readonly counts: Readonly<Record<string, number>>;
  readonly evaluatedAt: string;
}

/**
 * Versioned reputation-policy execution boundary.
 * Each policy version is a pure, deterministic function of its input.
 */
export interface ReputationPolicy {
  readonly version: string;
  execute(input: ReplayInput): PolicyExecutionResult;
}

/** The reconstructed input for a replay. */
export interface ReplayInput {
  readonly subjectId: string;
  readonly evaluatedAt: string;
  readonly evidence: readonly EvidenceRecord[];
}

/** Machine-readable replay outcome status. */
export type ReplayStatus = "match" | "mismatch" | "unavailable" | "unsupported_policy";

/** A single field-level difference between expected and actual. */
export interface ReplayDiff {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** Deterministic machine-readable replay report. */
export interface ReplayReport {
  readonly status: ReplayStatus;
  readonly evaluationId: string;
  readonly policyVersion: string;
  readonly manifestId: string | null;
  readonly diffs: readonly ReplayDiff[];
  readonly reason: string;
  /** Deterministic digest of the replay result for comparison across machines. */
  readonly replayDigest: string;
}

/** Errors that fail closed during replay. */
export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: ReplayErrorCode,
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

export type ReplayErrorCode =
  | "UNSUPPORTED_POLICY_VERSION"
  | "MANIFEST_MISSING"
  | "MANIFEST_MISMATCH"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_HASH_MISMATCH"
  | "INVALID_INPUT";

/** Read-only access to persisted historical facts. */
export interface HistoricalRepository {
  getEvaluation(evaluationId: string): ReputationEvaluation | undefined;
  getManifestForEvaluation(evaluationId: string): EvidenceManifest | undefined;
  getEvidenceRecord(evidenceId: string): EvidenceRecord | undefined;
}

/** Registry of historical policy versions. */
export interface ReputationPolicyRegistry {
  getPolicy(version: string): ReputationPolicy | undefined;
}

/** Options for a replay run. */
export interface ReplayOptions {
  readonly repository: HistoricalRepository;
  readonly policyRegistry: ReputationPolicyRegistry;
}

// -----------------------------------------------------------------------------
// Deterministic decimal arithmetic

/** A minimal deterministic decimal representation using scaled integers. */
interface Decimal {
  readonly scaled: bigint;
  readonly scale: number;
}

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

function parseDecimal(value: string): Decimal {
  if (!DECIMAL_RE.test(value)) {
    throw new ReplayError(`Invalid decimal value: ${value}`, "INVALID_INPUT");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [ intPart, fracPart = "" ] = unsigned.split(".");
  const scale = fracPart.length;
  const digits = `${intPart}${fracPart}`.replace(/^0+(?!$)/, "") || "0";
  const scaled = BigInt(digits) * (negative ? -1n : 1n);
  return { scaled, scale };
}

function alignDecimals(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  const aLigned = a.scaled * 10n ** BigInt(scale - a.scale);
  const bAligned = b.scaled * 10n ** BigInt(scale - b.scale);
  return [aAligned, bAligned, scale];
}

function addDecimals(a: Decimal, b: Decimal): Decimal {
  const [aAligned, bAligned, scale] = alignDecimals(a, b);
  return { scaled: aAligned + bAligned, scale };
}

function mulDecimals(a: Decimal, b: Decimal): Decimal {
  return { scaled: a.scaled * b.scaled, scale: a.scale + b.scale };
}

/** Round to a fixed number of fractional digits using half-up. */
function roundDecimal(value: Decimal, digits: number): Decimal {
  if (value.scale <= digits) {
    return value;
  }
  const factor = 10n ** BigInt(value.scale - digits);
  const negative = value.scaled < 0n;
  const abs = negative ? -value.scaled : value.scaled;
  const remainder = abs % factor;
  const half = factor / 2n;
  let quotient = abs / factor;
  if (remainder >= half) {
    quotient += 1n;
  }
  return { scaled: negative ? -quotient : quotient, scale: digits };
}

function decimalToString(value: Decimal): string {
  const negative = value.scaled < 0n;
  const abs = negative ? -value.scaled : value.scaled;
  const digits = abs.toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }
  const intPart = digits.slice(0, digits.length - value.scale);
  const fracPart = digits.slice(digits.length - value.scale);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

// -----------------------------------------------------------------------------
// Canonicalization & digests

/** Deterministic JSON canonicalization (always sorts object keys). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([i, v]) => `${JSON.stringify(i)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Compute the content hash of an evidence set. */
export function computeEvidenceHash(evidence: readonly EvidenceRecord[]): string {
  const ordered = [...evidence].sort((a, b) =>
    a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0,
  );
  return sha256(canonicalize(ordered));
}

/** Compute a deterministic digest of a policy execution result. */
export function computeReplayDigest(result: PolicyExecutionResult): string {
  return sha256(canonicalize(normalizeResult(result)));
}

/** Normalize a result for comparison (sort components, drop undefined). */
export function normalizeResult(result: PolicyExecutionResult): PolicyExecutionResult {
  const components = [...result.components].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const countsEntries = Object.entries(result.counts).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return {
    state: result.state,
    score: result.score,
    band: result.band,
    components,
    metrics: result.metrics,
    counts: Object.fromEntries(countsEntries),
    evaluatedAt: result.evaluatedAt,
  };
}

// -----------------------------------------------------------------------------
// Built-in historical policy versions

/** Policy v1: weighted success ratio minus dispute penalty. */
const POLICY_V1: ReputationPolicy = {
  version: "v1",
  execute(input) {
    const metrics = deriveMetrics(input.evidence);
    const total = metrics.totalTrustedTransferOutcomes;
    const success = metrics.successfulTransferOutcomes;
    const disputes = metrics.disputeCount;

    const successRate = total === 0
      ? parseDecimal("0")
      : roundDecimal(
          mulDecimals(
            parseDecimal(String(success)),
            parseDecimal("1"),
          ),
          4,
        );
    // Explicit ratio: success / total, rounded to 4 decimals.
    const ratio: Decimal = total === 0
      ? parseDecimal("0")
      : roundDecimal(
          {
            scaled: (parseDecimal(String(success)).scaled * 10000n * 1n) /
              BigInt(total),
            scale: 4,
          },
          4,
        );

    const disputePenalty = roundDecimal(
      mulDecimals(parseDecimal(String(disputes)), parseDecimal("0.05")),
      4,
    );

    const components: ReputationComponent[] = [
      {
        name: "success_ratio",
        weight: "1",
        value: decimalToString(ratio),
        contribution: decimalToString(ratio),
      },
      {
        name: "dispute_penalty",
        weight: "0.05",
        value: decimalToString(disputePenalty),
        contribution: decimalToString(
          mulDecimals(disputePenalty, parseDecimal("-1")),
        ),
      },
    ];

    const score = roundDecimal(
      addDecimals(ratio, mulDecimals(disputePenalty, parseDecimal("-1"))),
      4,
    );

    const band = bandForScore(score);
    const state = total === 0 ? "UNTRUSTED" : "RECOGNIZED";
    const counts: Record<string, number> = {
      evidence_records: input.evidence.length,
      transfer_outcomes: total,
      disputes,
    };

    return {
      state,
      score: decimalToString(score),
      band,
      components,
      metrics,
      counts,
      evaluatedAt: input.evaluatedAt,
    };
  },
};

/** Policy v2: adds an account-age bonus and tighter dispute penalty. */
const POLICY_V2: ReputationPolicy = {
  version: "v2",
  execute(input) {
    const metrics = deriveMetrics(input.evidence);
    const total = metrics.totalTrustedTransferOutcomes;
    const success = metrics.successfulTransferOutcomes;
    const disputes = metrics.disputeCount;
    const ageDays = metrics.ageDays;

    const ratio = total === 0
      ? parseDecimal("0")
      : roundDecimal(
          {
            scaled: (parseDecimal(String(success)).scaled * 10000n * 1n) /
              BigInt(total),
            scale: 4,
          },
          4,
        );

    const disputePenalty = roundDecimal(
      mulDecimals(parseDecimal(String(disputes)), parseDecimal("0.1")),
      4,
    );

    const ageBonus = roundDecimal(
      mulDecimals(parseDecimal(String(ageDays)), parseDecimal("0.001")),
      4,
    );

    const components: ReputationComponent[] = [
      {
        name: "success_ratio",
        weight: "1",
        value: decimalToString(ratio),
        contribution: decimalToString(ratio),
      },
      {
        name: "dispute_penalty",
        weight: "0.1",
        value: decimalToString(disputePenalty),
        contribution: decimalToString(
          mulDecimals(disputePenalty, parseDecimal("-1")),
        ),
      },
      {
        name: "age_bonus",
        weight: "0.001",
        value: decimalToString(ageBonus),
        contribution: decimalToString(ageBonus),
      },
    ];

    const score = roundDecimal(
      addDecimals(
        addDecimals(ratio, mulDecimals(disputePenalty, parseDecimal("-1"))),
        ageBonus,
      ),
      4,
    );

    const band = bandForScore(score);
    const state = total === 0 ? "UNTRUSTED" : "RECOGNIZED";
    const counts: Record<string, number> = {
      evidence_records: input.evidence.length,
      transfer_outcomes: total,
      disputes,
    };

    return {
      state,
      score: decimalToString(score),
      band,
      components,
      metrics,
      counts,
      evaluatedAt: input.evaluatedAt,
    };
  },
};

/** The built-in historical policy versions. */
export const BUILTIN_POLICIES: readonly ReputationPolicy[] = [POLICY_V1, POLICY_V2];

/** Default policy registry exposing the built-in historical versions. */
export class BuiltinPolicyRegistry implements ReputationPolicyRegistry {
  private readonly byVersion: Map<string, ReputationPolicy>;

  constructor(policies: readonly ReputationPolicy[] = BUILTIN_POLICIES) {
    this.byVersion = new Map(policies.map((p) => [p.version, p]));
  }

  getPolicy(version: string): ReputationPolicy | undefined {
    return this.byVersion.get(version);
  }
}

/** Derive metrics from the recorded evidence set. */
function deriveMetrics(evidence: readonly EvidenceRecord[]): ReputationMetrics {
  let totalTrustedTransferOutcomes = 0;
  let successfulTransferOutcomes = 0;
  let failedTransferOutcomes = 0;
  let disputeCount = 0;
  let ageDays = 0;

  for (const record of evidence) {
    switch (record.kind) {
      case "transfer_outcome": {
        const trusted = record.payload.trusted;
        if (trusted === true) {
          totalTrustedTransferOutcomes += 1;
          const outcome = record.payload.outcome;
          if (outcome === "success") {
            successfulTransferOutcomes += 1;
          } else if (outcome === "failure") {
            failedTransferOutcomes += 1;
          }
        }
        break;
      }
      case "dispute": {
        disputeCount += 1;
        break;
      }
      case "account_age": {
        const days = record.payload.days;
        if (typeof days === "number" && Number.isInteger(days) && days >= 0) {
          ageDays = days;
        }
        break;
      }
      case "provenance_rate":
        // Rate evidence does not contribute to v1/v2 metrics but is retained
        // for future policy versions and provenance auditing (#113).
        break;
      default:
        throw new ReplayError(
          `Unknown evidence record kind: ${String(record.kind)}`,
          "INVALID_INPUT",
        );
    }
  }

  return {
    totalTrustedTransferOutcomes,
    successfulTransferOutcomes,
    failedTransferOutcomes,
    disputeCount,
    ageDays,
  };
}

function bandForScore(score: Decimal): ReputationBand {
  const high = parseDecimal("0.8");
  const medium = parseDecimal("0.5");
  const low = parseDecimal("0.2");
  const [, scoreAligned, scale] = alignDecimals(score, high);
  const highAligned = high.scaled * 10n ** BigInt(scale - high.scale);
  if (scoreAligned >= highAligned) {
    return "HIGH";
  }
  const mediumAligned = medium.scaled * 10n ** BigInt(scale - medium.scale);
  if (scoreAligned >= mediumAligned) {
    return "MEDIUM";
  }
  const lowAligned = low.scaled * 10n ** BigInt(scale - low.scale);
  if (scoreAligned >= lowAligned) {
    return "LOW";
  }
  return "UNTRUSTED";
}

// -----------------------------------------------------------------------------
// Replay driver

/** Reconstruct the replay input from a manifest and its evidence records. */
export function reconstructInput(
  evaluation: ReputationEvaluation,
  manifest: EvidenceManifest,
  repository: HistoricalRepository,
): ReplayInput {
  if (manifest.evaluationId !== evaluation.evaluationId) {
    throw new ReplayError(
      `Manifest ${manifest.manifestId} does not belong to evaluation ${evaluation.evaluationId}`,
      "MANIFEST_MISMATCH",
    );
  }
  if (manifest.policyVersion !== evaluation.policyVersion) {
    throw new ReplayError(
      `Manifest policy version ${manifest.policyVersion} does not match evaluation policy version ${evaluation.policyVersion}`,
      "MANIFEST_MISMATCH",
    );
  }

  const evidence: EvidenceRecord[] = [];
  for (const evidenceId of manifest.evidenceIds) {
    const record = repository.getEvidenceRecord(evidenceId);
    if (!record) {
      throw new ReplayError(
        `Evidence record ${evidenceId} referenced by manifest ${manifest.manifestId} is missing`,
        "EVIDENCE_MISSING",
      );
    }
    if (record.subjectId !== evaluation.subjectId) {
      throw new ReplayError(
        `Evidence record ${evidenceId} subject ${record.subjectId} does not match evaluation subject ${evaluation.subjectId}`,
        "MANIFEST_MISMATCH",
      );
    }
    evidence.push(record);
  }

  const actualHash = computeEvidenceHash(evidence);
  if (actualHash !== manifest.evidenceHash) {
    throw new ReplayError(
      `Evidence hash mismatch for manifest ${manifest.manifestId}: expected ${manifest.evidenceHash}, got ${actualHash}`,
      "EVIDENCE_HASH_MISMATCH",
    );
  }

  return {
    subjectId: evaluation.subjectId,
    evaluatedAt: evaluation.evaluatedAt,
    evidence,
  };
}

/** Compare an expected result against an actual result, producing field-level diffs. */
export function diffResults(
  expected: PolicyExecutionResult,
  actual: PolicyExecutionResult,
): ReplayDiff[] {
  const diffs: ReplayDiff[] = [];
  const normalizedExpected = normalizeResult(expected);
  const normalizedActual = normalizeResult(actual);

  const compare = (path: string, e: unknown, a: unknown): void => {
    if (canonicalize(e) !== canonicalize(a)) {
      diffs.push({ path, expected: e, actual: a });
    }
  };

  compare("state", normalizedExpected.state, normalizedActual.state);
  compare("score", normalizedExpected.score, normalizedActual.score);
  compare("band", normalizedExpected.band, normalizedActual.band);
  compare("evaluatedAt", normalizedExpected.evaluatedAt, normalizedActual.evaluatedAt);
  compare("metrics", normalizedExpected.metrics, normalizedActual.metrics);
  compare("counts", normalizedExpected.counts, normalizedActual.counts);

  const expectedComponents = new Map(normalizedExpected.components.map((c) => [c.name, c]));
  const actualComponents = new Map(normalizedActual.components.map((c) => [c.name, c]));
  const allNames = [...new Set([...expectedComponents.keys(), ...actualComponents.keys()])].sort();
  for (const name of allNames) {
    compare(
      `components.${name}`,
      expectedComponents.get(name) ?? null,
      actualComponents.get(name) ?? null,
    );
  }

  return diffs;
}

/** Extract the expected execution result from a persisted evaluation. */
export function expectedResultFromEvaluation(
  evaluation: ReputationEvaluation,
): PolicyExecutionResult {
  return {
    state: evaluation.state,
    score: evaluation.score,
    band: evaluation.band,
    components: evaluation.components,
    metrics: evaluation.metrics,
    counts: evaluation.counts,
    evaluatedAt: evaluation.evaluatedAt,
  };
}

/**
 * Run a deterministic replay of a historical evaluation.
 *
 * This is pure and read-only: it never writes and never makes network requests.
 */
export function replayEvaluation(
  evaluationId: string,
  options: ReplayOptions,
): ReplayReport {
  const { repository, policyRegistry } = options;

  const evaluation = repository.getEvaluation(evaluationId);
  if (!evaluation) {
    throw new ReplayError(
      `Evaluation ${evaluationId} not found`,
      "INVALID_INPUT",
    );
  }

  const manifest = repository.getManifestForEvaluation(evaluationId);
  if (!manifest) {
    return {
      status: "unavailable",
      evaluationId,
      policyVersion: evaluation.policyVersion,
      manifestId: null,
      diffs: [],
      reason: `No evidence manifest was recorded for evaluation ${evaluationId}; replay is unavailable`,
      replayDigest: sha256(canonicalize({ evaluationId, status: "unavailable" })),
    };
  }

  const policy = policyRegistry.getPolicy(evaluation.policyVersion);
  if (!policy) {
    return {
      status: "unsupported_policy",
      evaluationId,
      policyVersion: evaluation.policyVersion,
      manifestId: manifest.manifestId,
      diffs: [],
      reason: `Policy version ${evaluation.policyVersion} is not supported by this replay engine`,
      replayDigest: sha256(
        canonicalize({
          evaluationId,
          policyVersion: evaluation.policyVersion,
          status: "unsupported_policy",
        }),
      ),
    };
  }

  if (manifest.policyVersion !== evaluation.policyVersion) {
    throw new ReplayError(
      `Manifest policy version ${manifest.policyVersion} does not match evaluation policy version ${evaluation.policyVersion}`,
      "MANIFEST_MISMATCH",
    );
  }

  const input = reconstructInput(evaluation, manifest, repository);
  const actual = policy.execute(input);
  const expected = expectedResultFromEvaluation(evaluation);
  const diffs = diffResults(expected, actual);
  const status: ReplayStatus = diffs.length === 0 ? "match" : "mismatch";

  return {
    status,
    evaluationId,
    policyVersion: evaluation.policyVersion,
    manifestId: manifest.manifestId,
    diffs,
    reason: status === "match"
      ? `Replay reproduced evaluation ${evaluationId} exactly`
      : `Replay produced ${diffs.length} field difference(s) from the persisted evaluation`,
    replayDigest: computeReplayDigest(actual),
  };
}

/** Render a human-readable report from a machine-readable replay report. */
export function renderReplayReport(report: ReplayReport): string {
  const lines: string[] = [
    `Replay verification for evaluation ${report.evaluationId}`,
    `Policy version: ${report.policyVersion}`,
    `Manifest: ${report.manifestId ?? "<none>"}`,
    `Status: ${report.status}`,
    `Reason: ${report.reason}`,
    `Replay digest: ${report.replayDigest}`,
  ];
  if (report.diffs.length > 0) {
    lines.push("Differences:");
    for (const diff of report.diffs) {
      lines.push(
        `  - ${diff.path}: expected ${canonicalize(diff.expected)}, actual ${canonicalize(diff.actual)}`,
      );
    }
  }
  return lines.join("\n");
}
