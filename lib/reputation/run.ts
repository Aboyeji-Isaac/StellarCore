import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { getDbForWorkload, SCHEDULED_WORKLOAD } from "@/lib/db/workloadAccessor";
import { PrismaClient } from "@/app/generated/prisma/client";
import type { ReputationEvaluationResult } from "@/types/reputation";
import type { ReputationRepositoryDependencies } from "@/lib/reputation/repository";

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
  listAnchorSlugs: (db?: PrismaClient) => Promise<readonly string[]>;
  evaluate: (
    anchorSlug: string,
    options: Readonly<{ evaluatedAt: Date; dbDependencies?: ReputationRepositoryDependencies }>,
  ) => Promise<ReputationEvaluationResult>;
}>;

export type ReputationEvaluationRunOptions = Readonly<{
  anchorSlugs?: readonly string[];
  evaluatedAt?: Date;
  dependencies?: ReputationEvaluationRunDependencies;
  db?: PrismaClient;
}>;

async function listAnchorSlugs(db?: PrismaClient): Promise<readonly string[]> {
  const database = db ?? getDbForWorkload(SCHEDULED_WORKLOAD);
  const anchors = await database.anchor.findMany({
    orderBy: { slug: "asc" },
    select: { slug: true },
  });
  return Object.freeze(anchors.map(({ slug }) => slug));
}

export async function evaluatePersistedAnchorReputations(
  options: ReputationEvaluationRunOptions = {},
): Promise<ReputationEvaluationRunSummary> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const db = options.db ?? getDbForWorkload(SCHEDULED_WORKLOAD);
  const anchorSlugs = normalizeSlugs(
    options.anchorSlugs ?? await dependencies.listAnchorSlugs(db),
  );
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const failures: ReputationEvaluationRunFailure[] = [];
  let succeeded = 0;

  for (const anchorSlug of anchorSlugs) {
    const result = await dependencies.evaluate(anchorSlug, {
      evaluatedAt,
      dbDependencies: { db },
    });
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

const DEFAULT_DEPENDENCIES = Object.freeze({
  listAnchorSlugs,
  evaluate: evaluateAnchorReputation,
}) satisfies ReputationEvaluationRunDependencies;

function normalizeSlugs(slugs: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(slugs)].sort((left, right) =>
    left.localeCompare(right)));
}
