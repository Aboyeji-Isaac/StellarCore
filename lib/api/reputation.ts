import { isValidAnchorSlug } from "@/lib/api/anchors";
import {
  PRISMA_REPUTATION_API_REPOSITORY,
  type ReputationApiAnchorRecord,
  type ReputationApiRepository,
} from "@/lib/api/reputationRepository";
import { isRequestCancellationError } from "@/lib/api/requestContext";
import type {
  PublicReputation,
  PublicReputationListResponse,
  PublicReputationScoreBand,
  PublicReputationState,
  ReputationApiDetailResult,
  ReputationApiErrorResponse,
  ReputationApiListResult,
} from "@/types/api/reputation";
import type { RequestContext } from "@/types/api/requestContext";

export type ReputationApiDependencies = Readonly<{
  repository?: ReputationApiRepository;
  context?: RequestContext;
}>;

export async function getReputationApiResult(
  dependencies: ReputationApiDependencies = {},
): Promise<ReputationApiListResult> {
  const { context } = dependencies;

  try {
    context?.assertActive();
    const repository = dependencies.repository ?? PRISMA_REPUTATION_API_REPOSITORY;
    const records = await repository.findAll(context);
    context?.assertActive();
    return Object.freeze({ status: 200, body: serializeReputationList(records) });
  } catch (error) {
    if (isRequestCancellationError(error)) throw error;
    return listInternalError();
  }
}

export async function getAnchorReputationApiResult(
  slug: string,
  dependencies: ReputationApiDependencies = {},
): Promise<ReputationApiDetailResult> {
  if (!isValidAnchorSlug(slug)) {
    return Object.freeze({
      status: 400,
      body: errorBody("invalid_anchor_slug", "A valid anchor slug is required."),
    });
  }

  const { context } = dependencies;

  try {
    context?.assertActive();
    const repository = dependencies.repository ?? PRISMA_REPUTATION_API_REPOSITORY;
    const record = await repository.findBySlug(slug, context);
    context?.assertActive();
    if (!record) {
      return Object.freeze({
        status: 404,
        body: errorBody("anchor_not_found", "Anchor not found."),
      });
    }
    return Object.freeze({
      status: 200,
      body: Object.freeze({ reputation: serializeReputation(record) }),
    });
  } catch (error) {
    if (isRequestCancellationError(error)) throw error;
    return detailInternalError();
  }
}

export function serializeReputationList(
  records: readonly ReputationApiAnchorRecord[],
): PublicReputationListResponse {
  const reputation = Object.freeze([...records]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map(serializeReputation));
  return Object.freeze({ reputation, count: reputation.length });
}

export function serializeReputation(record: ReputationApiAnchorRecord): PublicReputation {
  const anchor = Object.freeze({ slug: record.slug, name: record.name });
  const persisted = record.reputationScore;
  if (!persisted) {
    return Object.freeze({
      anchor,
      state: "not_evaluated",
      score: null,
      scoreBand: null,
      evidence: null,
      metrics: null,
      computedAt: null,
    });
  }

  return Object.freeze({
    anchor,
    state: publicState(persisted.state),
    score: safeScore(persisted.compositeScore),
    scoreBand: publicScoreBand(persisted.scoreBand),
    evidence: Object.freeze({ outcomeCount: persisted.sampleSize }),
    metrics: Object.freeze({
      fillRate7d: safeNumber(persisted.fillRate7d),
      fillRate30d: safeNumber(persisted.fillRate30d),
      fillRate90d: safeNumber(persisted.fillRate90d),
      settleP50Ms: safeNumber(persisted.settleP50Ms),
      settleP95Ms: safeNumber(persisted.settleP95Ms),
      slippageP50: safeNumber(persisted.slippageP50),
      slippageP95: safeNumber(persisted.slippageP95),
    }),
    computedAt: persisted.computedAt.toISOString(),
  });
}

function publicState(state: "INSUFFICIENT_DATA" | "OK"): PublicReputationState {
  return state === "OK" ? "established" : "insufficient_evidence";
}

function publicScoreBand(
  scoreBand: "GREEN" | "AMBER" | "RED" | null,
): PublicReputationScoreBand | null {
  return scoreBand?.toLowerCase() as PublicReputationScoreBand | undefined ?? null;
}

function safeScore(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function safeNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function errorBody(
  code: ReputationApiErrorResponse["error"]["code"],
  message: string,
): ReputationApiErrorResponse {
  return Object.freeze({ error: Object.freeze({ code, message }) });
}

function listInternalError(): ReputationApiListResult {
  return Object.freeze({
    status: 500,
    body: errorBody("internal_error", "Unable to load reputation."),
  });
}

function detailInternalError(): ReputationApiDetailResult {
  return Object.freeze({
    status: 500,
    body: errorBody("internal_error", "Unable to load reputation."),
  });
}
