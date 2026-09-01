import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import type { ReputationEvaluationResult } from "@/types/reputation";

export type ReputationEvaluationRunFailure = Readonly<{
  anchorSlug: string;
  code: Exclude<ReputationEvaluationResult, { ok: true }>["code"];
}>;

export type ReputationEvaluationRunSummary = Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
  failures: readonly ReputationEvaluationRunFailure[];
}>;

export type ReputationEvaluationRunDependencies = Readonly<{
  listAnchorSlugs: () => Promise<readonly string[]>;
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

export async function evaluatePersistedAnchorReputations(
  options: ReputationEvaluationRunOptions = {},
): Promise<ReputationEvaluationRunSummary> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const anchorSlugs = normalizeSlugs(
    options.anchorSlugs ?? await dependencies.listAnchorSlugs(),
  );
  const evaluatedAt = options.evaluatedAt ?? new Date();
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
  evaluate: evaluateAnchorReputation,
}) satisfies ReputationEvaluationRunDependencies;

function normalizeSlugs(slugs: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(slugs)].sort((left, right) =>
    left.localeCompare(right)));
}
