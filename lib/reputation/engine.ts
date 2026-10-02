import { REPUTATION_OUTCOME_WINDOW_DAYS } from "@/constants/reputation";
import { SYSTEM_CLOCK } from "@/lib/clock/clock";
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
  const evaluatedAt = options.evaluatedAt ?? SYSTEM_CLOCK.now();
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
    // Repository implementations must return typed read failures instead of
    // throwing; an unexpected throw is still bounded as a read failure and
    // never leaks its message (which could contain credentials).
    return failure(anchorSlug, "EVIDENCE_READ_FAILURE");
  }
  if (!evidence) return failure(anchorSlug, "ANCHOR_NOT_FOUND");
  if (!isReputationEvidence(evidence)) {
    return failure(
      anchorSlug,
      evidence.code,
    );
  }

  const calculation = calculateReputation(evidence, evaluatedAt);
  if (options.persist === false) {
    return Object.freeze({
      ok: true,
      calculation,
      persisted: null,
      snapshot: evidence.snapshot,
    });
  }

  try {
    const persisted = await repository.upsertScore({
      anchorId: evidence.anchorId,
      calculation,
    });
    return Object.freeze({
      ok: true,
      calculation,
      persisted,
      snapshot: evidence.snapshot,
    });
  } catch {
    return failure(anchorSlug, "PERSISTENCE_FAILURE");
  }
}

function isReputationEvidence(
  value: Awaited<ReturnType<ReputationRepository["readEvidence"]>>,
): value is Exclude<
  NonNullable<Awaited<ReturnType<ReputationRepository["readEvidence"]>>>,
  { code: string; retryable: boolean; attempts: number }
> {
  if (value === null) return false;
  return !("retryable" in value && "attempts" in value && typeof value.retryable === "boolean");
}

function failure(
  anchorSlug: string,
  code: Exclude<ReputationEvaluationResult, { ok: true }>["code"],
): ReputationEvaluationResult {
  return Object.freeze({ ok: false, anchorSlug, code });
}
