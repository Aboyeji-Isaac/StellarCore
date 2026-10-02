import { runWithinContext } from "@/lib/api/requestContext";
import type { RequestContext } from "@/types/api/requestContext";
import type { ReputationState, ReputationScoreBand } from "@/app/generated/prisma/enums";

export type ReputationApiScoreRecord = Readonly<{
  compositeScore: number | null;
  scoreBand: ReputationScoreBand | null;
  fillRate7d: number | null;
  fillRate30d: number | null;
  fillRate90d: number | null;
  settleP50Ms: number | null;
  settleP95Ms: number | null;
  slippageP50: number | null;
  slippageP95: number | null;
  sampleSize: number;
  state: ReputationState;
  computedAt: Date;
}>;

export type ReputationApiAnchorRecord = Readonly<{
  slug: string;
  name: string;
  reputationScore: ReputationApiScoreRecord | null;
}>;

export type ReputationApiRepository = Readonly<{
  findAll: (context?: RequestContext) => Promise<readonly ReputationApiAnchorRecord[]>;
  findBySlug: (
    slug: string,
    context?: RequestContext,
  ) => Promise<ReputationApiAnchorRecord | null>;
}>;

const REPUTATION_SCORE_SELECT = {
  compositeScore: true,
  scoreBand: true,
  fillRate7d: true,
  fillRate30d: true,
  fillRate90d: true,
  settleP50Ms: true,
  settleP95Ms: true,
  slippageP50: true,
  slippageP95: true,
  sampleSize: true,
  state: true,
  computedAt: true,
} as const;

export const PRISMA_REPUTATION_API_REPOSITORY = Object.freeze({
  async findAll(
    context?: RequestContext,
  ): Promise<readonly ReputationApiAnchorRecord[]> {
    context?.assertActive();
    const { db } = await import("@/lib/dbClient");

    return runWithinContext(context, async () => {
      const anchors = await db.anchor.findMany({
        orderBy: { slug: "asc" },
        select: { slug: true, name: true, reputationScore: { select: REPUTATION_SCORE_SELECT } },
      });

      return Object.freeze(anchors.map(toRecord));
    });
  },

  async findBySlug(
    slug: string,
    context?: RequestContext,
  ): Promise<ReputationApiAnchorRecord | null> {
    context?.assertActive();
    const { db } = await import("@/lib/dbClient");

    return runWithinContext(context, async () => {
      const anchor = await db.anchor.findUnique({
        where: { slug },
        select: { slug: true, name: true, reputationScore: { select: REPUTATION_SCORE_SELECT } },
      });

      return anchor ? toRecord(anchor) : null;
    });
  },
}) satisfies ReputationApiRepository;

function toRecord(anchor: {
  slug: string;
  name: string;
  reputationScore: ReputationApiScoreRecord | null;
}): ReputationApiAnchorRecord {
  return Object.freeze({
    slug: anchor.slug,
    name: anchor.name,
    reputationScore: anchor.reputationScore
      ? Object.freeze({ ...anchor.reputationScore, computedAt: new Date(anchor.reputationScore.computedAt) })
      : null,
  });
}
