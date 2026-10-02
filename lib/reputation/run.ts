import { SYSTEM_CLOCK } from "@/lib/clock/clock";
import { PRISMA_REPUTATION_CLOCK_GUARD } from "@/lib/clock/clockIntegrityRepository";
import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import type { ClockIntegrityVerdict } from "@/types/clock";
import type { ReputationEvaluationResult } from "@/types/reputation";

export type ReputationEvaluationRunFailure = Readonly<{
  /** Absent for a run-level clock-integrity failure. */
  anchorSlug?: string;
  code: string;
}>;

export type ReputationEvaluationRunSummary = Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
  failures: readonly ReputationEvaluationRunFailure[];
  clockIntegrity: ClockIntegrityVerdict | null;
}>;

export type ReputationEvaluationRunDependencies = Readonly<{
  listAnchorSlugs: () => Promise<readonly string[]>;
  checkClockIntegrity: () => Promise<ClockIntegrityVerdict>;
  now: () => Date;
  evaluate: (
    anchorSlug: string,
    options: Readonly<{ evaluatedAt: Date }>,
  ) => Promise<ReputationEvaluationResult>;
}>;

export type ReputationEvaluationRunOptions = Readonly<{
  anchorSlugs?: readonly string[];
  evaluatedAt?: Date;
  dependencies?: ReputationEvaluationRunDependencies;
}>;

/**
 * Evaluates persisted anchor reputations for one run. A single run-level
 * clock-integrity check anchors the rolling windows of every anchor, so clock
 * skew cannot extend or shift a window and no per-anchor database round trip is
 * added.
 */
export async function evaluatePersistedAnchorReputations(
  options: ReputationEvaluationRunOptions = {},
): Promise<ReputationEvaluationRunSummary> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const verdict = await dependencies.checkClockIntegrity();
  if (verdict.outcome === "REJECTED") {
    return clockIntegrityRejection(verdict);
  }

  const anchorSlugs = normalizeSlugs(
    options.anchorSlugs ?? await dependencies.listAnchorSlugs(),
  );
  const evaluatedAt = options.evaluatedAt ?? dependencies.now();
  const failures: ReputationEvaluationRunFailure[] = [];
  let succeeded = 0;

  for (const anchorSlug of anchorSlugs) {
    const result = await dependencies.evaluate(anchorSlug, { evaluatedAt });
    if (result.ok) {
      succeeded += 1;
      continue;
    }
    failures.push(Object.freeze({ anchorSlug: result.anchorSlug, code: result.code }));
  }

  return Object.freeze({
    attempted: anchorSlugs.length,
    succeeded,
    failed: failures.length,
    failures: Object.freeze(failures),
    clockIntegrity: null,
  });
}

function clockIntegrityRejection(
  verdict: ClockIntegrityVerdict,
): ReputationEvaluationRunSummary {
  return Object.freeze({
    attempted: 0,
    succeeded: 0,
    failed: 1,
    failures: Object.freeze([
      Object.freeze({ code: verdict.code ?? "CLOCK_SKEW_EXCEEDED" }),
    ]),
    clockIntegrity: verdict,
  });
}

async function listPersistedAnchorSlugs(): Promise<readonly string[]> {
  const { db } = await import("@/lib/dbClient");
  const anchors = await db.anchor.findMany({
    orderBy: { slug: "asc" },
    select: { slug: true },
  });
  return Object.freeze(anchors.map(({ slug }) => slug));
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  listAnchorSlugs: listPersistedAnchorSlugs,
  checkClockIntegrity: PRISMA_REPUTATION_CLOCK_GUARD.check,
  now: SYSTEM_CLOCK.now,
  evaluate: evaluateAnchorReputation,
}) satisfies ReputationEvaluationRunDependencies;

function normalizeSlugs(slugs: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(slugs)].sort((left, right) =>
    left.localeCompare(right)));
}
