import { REPUTATION_OUTCOME_WINDOW_DAYS } from "@/constants/reputation";
import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import { calculateReputation } from "@/lib/reputation/score";
import { getDbForWorkload, SCHEDULED_WORKLOAD } from "@/lib/db/workloadAccessor";
import type {
  ReputationEvaluationResult,
  ReputationRepository,
  ReputationUpsertResult,
} from "@/types/reputation";
import type { ReputationRepositoryDependencies } from "@/lib/reputation/repository";

const DAYS_TO_MS = 24 * 60 * 60 * 1_000;

export async function evaluateAnchorReputation(
  anchorSlug: string,
  options: Readonly<{
    repository?: ReputationRepository;
    evaluatedAt?: Date;
    persist?: boolean;
    dbDependencies?: ReputationRepositoryDependencies;
  }> = {},
): Promise<ReputationEvaluationResult> {
  const evaluatedAt = options.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return failure(anchorSlug, "INVALID_EVALUATION_TIME");
  }
  const repository = options.repository ?? PRISMA_REPUTATION_REPOSITORY;
  const dbDependencies = options.dbDependencies ?? { db: getDbForWorkload(SCHEDULED_WORKLOAD) };
  const outcomeWindowStart = new Date(
    evaluatedAt.getTime() - REPUTATION_OUTCOME_WINDOW_DAYS * DAYS_TO_MS,
  );

  let evidence;
  try {
    evidence = await repository.readEvidence(anchorSlug, outcomeWindowStart, dbDependencies);
  } catch {
    return failure(anchorSlug, "EVIDENCE_READ_FAILURE");
  }
  if (!evidence) return failure(anchorSlug, "ANCHOR_NOT_FOUND");

  const calculation = calculateReputation(evidence, evaluatedAt);
  if (options.persist === false) {
    return Object.freeze({ ok: true, calculation, persisted: null });
  }

  let upsertResult: ReputationUpsertResult;
  try {
    upsertResult = await repository.upsertScore({
      anchorId: evidence.anchorId,
      calculation,
    }, dbDependencies);
  } catch {
    return failure(anchorSlug, "PERSISTENCE_FAILURE");
  }

  if (!upsertResult.ok) {
    // Stale write - evaluation was valid but not persisted because a newer score exists
    return Object.freeze({ ok: true, calculation, persisted: null });
  }

  return Object.freeze({ ok: true, calculation, persisted: upsertResult.score });
}

function failure(
  anchorSlug: string,
  code: Exclude<ReputationEvaluationResult, { ok: true }>["code"],
): ReputationEvaluationResult {
  return Object.freeze({ ok: false, anchorSlug, code });
}
