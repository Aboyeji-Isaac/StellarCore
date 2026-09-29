import { REPUTATION_OUTCOME_WINDOW_DAYS } from "@/constants/reputation";
import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationEvaluationResult,
  ReputationRepository,
} from "@/types/reputation";

const DAYS_TO_MS = 24 * 60 * 60 * 1_000;

/**
 * Versioned reputation-policy execution boundary.
 *
 * Historical evaluations must be replayed with the policy version that
 * originally produced them. Unknown versions fail closed; today's policy is
 * never silently substituted for an older one.
 */
export const CURRENT_REPUTATION_POLICY_VERSION = 1 as const;

export type ReputationPolicyVersion = number;

export type ReputationReplayUnavailableReason =
  | "MANIFEST_MISSING"
  | "MANIFEST_INCOMPLETE";

export type ReputationReplayMismatchField =
  | "state"
  | "score"
  | "band"
  | "components"
  | "metrics"
  | "counts"
  | "evaluatedAt";

export type ReputationReplayResult =
  | Readonly<{
      ok: true;
      status: "VERIFIED";
      anchorSlug: string;
      policyVersion: ReputationPolicyVersion;
      evaluatedAt: string;
      calculation: ReputationEvaluationResult extends { ok: true }
        ? never
        : never;
    }>
  | Readonly<{
      ok: false;
      status: "MISMATCH";
      anchorSlug: string;
      policyVersion: ReputationPolicyVersion;
      mismatches: ReadonlyArray<
        Readonly<{
          field: ReputationReplayMismatchField;
          expected: unknown;
          actual: unknown;
        }>
      >;
    }>
  | Readonly<{
      ok: false;
      status: "UNSUPPORTED_POLICY_VERSION";
      anchorSlug: string;
      policyVersion: ReputationPolicyVersion;
    }>
  | Readonly<{
      ok: false;
      status: "REPLAY_UNAVAILABLE";
      anchorSlug: string;
      reason: ReputationReplayUnavailableReason;
    }>;

export interface ReputationReplayManifest {
  readonly policyVersion: ReputationPolicyVersion;
  readonly evaluatedAt: string;
  readonly outcomeWindowStart: string;
  readonly anchorId: string;
  readonly anchorSlug: string;
  readonly evidence: unknown;
  readonly calculation: unknown;
}

export interface ReputationReplaySource {
  readManifest(
    anchorSlug: string,
  ): Promise<ReputationReplayManifest | null | undefined>;
}

const SUPPORTED_POLICY_VERSIONS: ReadonlySet<ReputationPolicyVersion> =
  new Set([CURRENT_REPUTATION_POLICY_VERSION]);

function isSupportedPolicyVersion(
  version: ReputationPolicyVersion,
): boolean {
  return SUPPORTED_POLICY_VERSIONS.has(version);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Deterministically replay a persisted historical reputation evaluation
 * against its immutable evidence manifest.
 *
 * Read-only: performs no writes and no network requests. Never rewrites the
 * historical evaluation when a mismatch is detected.
 */
export async function replayReputationEvaluation(
  anchorSlug: string,
  source: ReputationReplaySource,
): Promise<ReputationReplayResult> {
  let manifest: ReputationReplayManifest | null | undefined;
  try {
    manifest = await source.readManifest(anchorSlug);
  } catch {
    return Object.freeze({
      ok: false,
      status: "REPLAY_UNAVAILABLE",
      anchorSlug,
      reason: "MANIFEST_MISSING",
    });
  }

  if (!manifest) {
    return Object.freeze({
      ok: false,
      status: "REPLAY_UNAVAILABLE",
      anchorSlug,
      reason: "MANIFEST_MISSING",
    });
  }

  if (
    manifest.evidence === undefined ||
    manifest.calculation === undefined ||
    typeof manifest.evaluatedAt !== "string" ||
    typeof manifest.policyVersion !== "number"
  ) {
    return Object.freeze({
      ok: false,
      status: "REPLAY_UNAVAILABLE",
      anchorSlug,
      reason: "MANIFEST_INCOMPLETE",
    });
  }

  if (!isSupportedPolicyVersion(manifest.policyVersion)) {
    return Object.freeze({
      ok: false,
      status: "UNSUPPORTED_POLICY_VERSION",
      anchorSlug,
      policyVersion: manifest.policyVersion,
    });
  }

  const evaluatedAt = new Date(manifest.evaluatedAt);
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return Object.freeze({
      ok: false,
      status: "REPLAY_UNAVAILABLE",
      anchorSlug,
      reason: "MANIFEST_INCOMPLETE",
    });
  }

  const replayed = calculateReputation(
    manifest.evidence as Parameters<typeof calculateReputation>[0],
    evaluatedAt,
  );
  const expected = manifest.calculation as Record<string, unknown>;
  const actual = replayed as unknown as Record<string, unknown>;

  const fields: ReadonlyArray<ReputationReplayMismatchField> = [
    "state",
    "score",
    "band",
    "components",
    "metrics",
    "counts",
  ];

  const mismatches: Array<{
    field: ReputationReplayMismatchField;
    expected: unknown;
    actual: unknown;
  }> = [];

  for (const field of fields) {
    if (!deepEqual(expected[field], actual[field])) {
      mismatches.push({
        field,
        expected: expected[field],
        actual: actual[field],
      });
    }
  }

  const expectedEvaluatedAt = new Date(
    String(expected.evaluatedAt ?? manifest.evaluatedAt),
  ).toISOString();
  const actualEvaluatedAt = evaluatedAt.toISOString();
  if (expectedEvaluatedAt !== actualEvaluatedAt) {
    mismatches.push({
      field: "evaluatedAt",
      expected: expectedEvaluatedAt,
      actual: actualEvaluatedAt,
    });
  }

  if (mismatches.length > 0) {
    return Object.freeze({
      ok: false,
      status: "MISMATCH",
      anchorSlug,
      policyVersion: manifest.policyVersion,
      mismatches: Object.freeze(mismatches.map((m) => Object.freeze(m))),
    });
  }

  return Object.freeze({
    ok: true,
    status: "VERIFIED",
    anchorSlug,
    policyVersion: manifest.policyVersion,
    evaluatedAt: actualEvaluatedAt,
    calculation: replayed as never,
  });
}

export function formatReputationReplayResult(
  result: ReputationReplayResult,
): string {
  switch (result.status) {
    case "VERIFIED":
      return `replay VERIFIED anchor=${result.anchorSlug} policy=${result.policyVersion} evaluatedAt=${result.evaluatedAt}`;
    case "MISMATCH":
      return [
        `replay MISMATCH anchor=${result.anchorSlug} policy=${result.policyVersion}`,
        ...result.mismatches.map(
          (m) =>
            `  ${m.field}: expected=${stableStringify(
              m.expected,
            )} actual=${stableStringify(m.actual)}`,
        ),
      ].join("\n");
    case "UNSUPPORTED_POLICY_VERSION":
      return `replay UNSUPPORTED_POLICY_VERSION anchor=${result.anchorSlug} policy=${result.policyVersion}`;
    case "REPLAY_UNAVAILABLE":
      return `replay REPLAY_UNAVAILABLE anchor=${result.anchorSlug} reason=${result.reason}`;
  }
}

export async function evaluateAnchorReputation(
  anchorSlug: string,
  options: Readonly<{
    repository?: ReputationRepository;
    evaluatedAt?: Date;
    persist?: boolean;
  }> = {},
): Promise<ReputationEvaluationResult> {
  const evaluatedAt = options.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return failure(anchorSlug, "INVALID_EVALUATION_TIME");
  }
  const repository = options.repository ?? PRISMA_REPUTATION_REPOSITORY;
  const outcomeWindowStart = new Date(
    evaluatedAt.getTime() - REPUTATION_OUTCOME_WINDOW_DAYS * DAYS_TO_MS,
  );

  let evidence;
  try {
    evidence = await repository.readEvidence(anchorSlug, outcomeWindowStart);
  } catch {
    return failure(anchorSlug, "EVIDENCE_READ_FAILURE");
  }
  if (!evidence) return failure(anchorSlug, "ANCHOR_NOT_FOUND");

  const calculation = calculateReputation(evidence, evaluatedAt);
  if (options.persist === false) {
    return Object.freeze({ ok: true, calculation, persisted: null });
  }

  try {
    const persisted = await repository.upsertScore({
      anchorId: evidence.anchorId,
      calculation,
    });
    return Object.freeze({ ok: true, calculation, persisted });
  } catch {
    return failure(anchorSlug, "PERSISTENCE_FAILURE");
  }
}

function failure(
  anchorSlug: string,
  code: Exclude<ReputationEvaluationResult, { ok: true }>["code"],
): ReputationEvaluationResult {
  return Object.freeze({ ok: false, anchorSlug, code });
}
