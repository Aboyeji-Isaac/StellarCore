import { REPUTATION_OUTCOME_WINDOW_DAYS } from "@/constants/reputation";
import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationEvaluationResult,
  ReputationRepository,
} from "@/types/reputation";

const DAYS_TO_MS = 24 * 60 * 60 * 1_000;

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
