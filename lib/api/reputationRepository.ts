import type { ReputationState, ReputationScoreBand } from "@/app/generated/prisma/enums";

export type ReputationApiScoreRecord = Readonly<{
  compositeScore: number | null;
  scoreBand: ReputationScoreBand | null;
  fillRate7d: number | string | null;
  fillRate30d: number | string | null;
  fillRate90d: number | string | null;
  settleP50Ms: number | null;
  settleP95Ms: number | null;
  slippageP50: number | string | null;
  slippageP95: number | string | null;
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
  findAll: () => Promise<readonly ReputationApiAnchorRecord[]>;
  findBySlug: (slug: string) => Promise<ReputationApiAnchorRecord | null>;
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
  async findAll(): Promise<readonly ReputationApiAnchorRecord[]> {
    const { db } = await import("@/lib/dbClient");
    const anchors = await db.anchor.findMany({
      orderBy: { slug: "asc" },
      select: { slug: true, name: true, reputationScore: { select: REPUTATION_SCORE_SELECT } },
    });

    return Object.freeze(anchors.map(toRecord));
  },

  async findBySlug(slug: string): Promise<ReputationApiAnchorRecord | null> {
    const { db } = await import("@/lib/dbClient");
    const anchor = await db.anchor.findUnique({
      where: { slug },
      select: { slug: true, name: true, reputationScore: { select: REPUTATION_SCORE_SELECT } },
    });

    return anchor ? toRecord(anchor) : null;
  },
}) satisfies ReputationApiRepository;

type DecimalValue = Readonly<{ toFixed: () => string }> | null;
type PersistedScoreRecord = Omit<ReputationApiScoreRecord,
  "fillRate7d" | "fillRate30d" | "fillRate90d" | "slippageP50" | "slippageP95"> & Readonly<{
    fillRate7d: DecimalValue;
    fillRate30d: DecimalValue;
    fillRate90d: DecimalValue;
    slippageP50: DecimalValue;
    slippageP95: DecimalValue;
  }>;

function toRecord(anchor: {
  slug: string;
  name: string;
  reputationScore: PersistedScoreRecord | null;
}): ReputationApiAnchorRecord {
  const score = anchor.reputationScore;
  return Object.freeze({
    slug: anchor.slug,
    name: anchor.name,
    reputationScore: score
      ? Object.freeze({
        ...score,
        fillRate7d: score.fillRate7d?.toFixed() ?? null,
        fillRate30d: score.fillRate30d?.toFixed() ?? null,
        fillRate90d: score.fillRate90d?.toFixed() ?? null,
        slippageP50: score.slippageP50?.toFixed() ?? null,
        slippageP95: score.slippageP95?.toFixed() ?? null,
        computedAt: new Date(score.computedAt),
      })
      : null,
  });
}
