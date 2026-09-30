import { Prisma } from "@/app/generated/prisma/client";
import { buildReputationEvidenceManifest } from "@/lib/reputation/manifest";
import type {
  PersistedReputationScore,
  ReputationCorridorMembershipValue,
  ReputationEvidence,
  ReputationEvidenceEligibilityValue,
  ReputationEvidenceReasonCodeValue,
  ReputationManifestRecord,
  ReputationManifestRepository,
  ReputationPersistenceInput,
  ReputationRepository,
  ReputationTransferStatus,
} from "@/types/reputation";

type LatestRateRow = Readonly<{
  rateSnapshotId: string;
  corridorId: string;
  corridorSlug: string;
  capturedAt: Date;
}>;

type ManifestRow = Readonly<{
  id: string;
  reputationScoreId: string;
  anchorStatus: ReputationManifestRecord["anchorStatus"];
  manifestSchemaVersion: number;
  reasonCodeVocabularyVersion: number;
  scoringPolicyVersion: string;
  freshnessPolicyVersion: string;
  configurationRevision: string;
  evaluatedAt: Date;
  outcomeWindowStart: Date;
  corridorCount: number;
  latestRateCount: number;
  freshRateCount: number;
  outcomeCount: number;
  completedOutcomeCount: number;
  outsideOutcomeCount: number;
  minimumOutcomeCount: number;
  createdAt: Date;
  anchor: Readonly<{ slug: string }>;
  corridorMembers: readonly {
    corridorId: string;
    membership: ReputationCorridorMembershipValue;
    reasonCode: ReputationEvidenceReasonCodeValue;
    ordinal: number;
  }[];
  rateMembers: readonly {
    rateSnapshotId: string;
    corridorId: string;
    capturedAt: Date;
    ageMs: number | null;
    eligibility: ReputationEvidenceEligibilityValue;
    reasonCode: ReputationEvidenceReasonCodeValue;
    ordinal: number;
  }[];
  outcomeMembers: readonly {
    transferOutcomeId: string;
    corridorId: string;
    status: ReputationTransferStatus;
    recordedAt: Date;
    eligibility: ReputationEvidenceEligibilityValue;
    reasonCode: ReputationEvidenceReasonCodeValue;
    ordinal: number;
  }[];
}>;

const MANIFEST_SELECT = {
  id: true,
  reputationScoreId: true,
  anchorStatus: true,
  manifestSchemaVersion: true,
  reasonCodeVocabularyVersion: true,
  scoringPolicyVersion: true,
  freshnessPolicyVersion: true,
  configurationRevision: true,
  evaluatedAt: true,
  outcomeWindowStart: true,
  corridorCount: true,
  latestRateCount: true,
  freshRateCount: true,
  outcomeCount: true,
  completedOutcomeCount: true,
  outsideOutcomeCount: true,
  minimumOutcomeCount: true,
  createdAt: true,
  anchor: { select: { slug: true } },
  corridorMembers: {
    orderBy: { ordinal: "asc" as const },
    select: {
      corridorId: true,
      membership: true,
      reasonCode: true,
      ordinal: true,
    },
  },
  rateMembers: {
    orderBy: { ordinal: "asc" as const },
    select: {
      rateSnapshotId: true,
      corridorId: true,
      capturedAt: true,
      ageMs: true,
      eligibility: true,
      reasonCode: true,
      ordinal: true,
    },
  },
  outcomeMembers: {
    orderBy: { ordinal: "asc" as const },
    select: {
      transferOutcomeId: true,
      corridorId: true,
      status: true,
      recordedAt: true,
      eligibility: true,
      reasonCode: true,
      ordinal: true,
    },
  },
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PRISMA_REPUTATION_REPOSITORY: ReputationRepository = Object.freeze({
  async readEvidence(anchorSlug, outcomeWindowStart) {
    const { db } = await import("@/lib/dbClient");
    const anchor = await db.anchor.findUnique({
      where: { slug: anchorSlug },
      select: {
        id: true,
        slug: true,
        status: true,
        corridors: {
          select: { corridor: { select: { id: true, slug: true } } },
        },
      },
    });
    if (!anchor) return null;

    const [latestRates, transferOutcomes, outsideOutcomeCount] = await Promise.all([
      db.$queryRaw<LatestRateRow[]>(Prisma.sql`
        SELECT DISTINCT ON (corridor.slug)
          snapshot.id AS "rateSnapshotId",
          corridor.id AS "corridorId",
          corridor.slug AS "corridorSlug",
          snapshot.captured_at AS "capturedAt"
        FROM rate_snapshots AS snapshot
        INNER JOIN corridors AS corridor ON corridor.id = snapshot.corridor_id
        WHERE snapshot.anchor_id = ${anchor.id}::uuid
        ORDER BY corridor.slug, snapshot.captured_at DESC, snapshot.id DESC
      `),
      db.transferOutcome.findMany({
        where: { anchorId: anchor.id, recordedAt: { gte: outcomeWindowStart } },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          corridorId: true,
          status: true,
          settlementMs: true,
          slippage: true,
          recordedAt: true,
        },
      }),
      db.transferOutcome.count({
        where: { anchorId: anchor.id, recordedAt: { lt: outcomeWindowStart } },
      }),
    ]);

    return Object.freeze({
      anchorId: anchor.id,
      anchorSlug: anchor.slug,
      status: anchor.status,
      corridors: Object.freeze(anchor.corridors
        .map(({ corridor }) => Object.freeze({
          corridorId: corridor.id,
          slug: corridor.slug,
        }))
        .sort((left, right) => left.slug.localeCompare(right.slug))),
      latestRates: Object.freeze(latestRates.map((rate) => Object.freeze({
        rateSnapshotId: rate.rateSnapshotId,
        corridorId: rate.corridorId,
        corridorSlug: rate.corridorSlug,
        capturedAt: new Date(rate.capturedAt.getTime()),
      }))),
      transferOutcomes: Object.freeze(transferOutcomes.map((outcome) =>
        Object.freeze({
          transferOutcomeId: outcome.id,
          corridorId: outcome.corridorId,
          status: outcome.status,
          settlementMs: outcome.settlementMs,
          slippage: outcome.slippage,
          recordedAt: new Date(outcome.recordedAt.getTime()),
        }))),
      outsideOutcomeCount,
    }) satisfies ReputationEvidence;
  },

  async upsertScore(input: ReputationPersistenceInput): Promise<PersistedReputationScore> {
    const { db } = await import("@/lib/dbClient");
    const { calculation } = input;
    const manifest = buildReputationEvidenceManifest({
      evidence: input.evidence,
      evaluatedAt: input.evaluatedAt,
      outcomeWindowStart: input.outcomeWindowStart,
    });
    const data = {
      compositeScore: calculation.score,
      scoreBand: calculation.scoreBand,
      fillRate7d: calculation.metrics.fillRate7d,
      fillRate30d: calculation.metrics.fillRate30d,
      fillRate90d: calculation.metrics.fillRate90d,
      settleP50Ms: calculation.metrics.settleP50Ms,
      settleP95Ms: calculation.metrics.settleP95Ms,
      slippageP50: calculation.metrics.slippageP50,
      slippageP95: calculation.metrics.slippageP95,
      sampleSize: calculation.evidence.outcomeCount,
      state: calculation.state === "established" ? "OK" : "INSUFFICIENT_DATA",
      computedAt: new Date(calculation.computedAt),
    } as const;

    // The current score projection and its immutable evidence-set manifest are
    // persisted in one transaction. If any member insert fails, the score
    // update is rolled back, so an evaluation can never become current without
    // a complete manifest.
    return db.$transaction(async (tx) => {
      const persisted = await tx.reputationScore.upsert({
        where: { anchorId: input.anchorId },
        create: { anchorId: input.anchorId, ...data },
        update: data,
        select: { id: true, computedAt: true, anchor: { select: { slug: true } } },
      });

      const storedManifest = await tx.reputationEvidenceManifest.create({
        data: {
          reputationScoreId: persisted.id,
          anchorId: input.anchorId,
          anchorStatus: manifest.anchorStatus,
          manifestSchemaVersion: manifest.manifestSchemaVersion,
          reasonCodeVocabularyVersion: manifest.reasonCodeVocabularyVersion,
          scoringPolicyVersion: manifest.scoringPolicyVersion,
          freshnessPolicyVersion: manifest.freshnessPolicyVersion,
          configurationRevision: manifest.configurationRevision,
          evaluatedAt: manifest.evaluatedAt,
          outcomeWindowStart: manifest.outcomeWindowStart,
          corridorCount: manifest.corridorCount,
          latestRateCount: manifest.latestRateCount,
          freshRateCount: manifest.freshRateCount,
          outcomeCount: manifest.outcomeCount,
          completedOutcomeCount: manifest.completedOutcomeCount,
          outsideOutcomeCount: manifest.outsideOutcomeCount,
          minimumOutcomeCount: manifest.minimumOutcomeCount,
          corridorMembers: {
            create: manifest.corridorMembers.map((member) => ({
              corridorId: member.corridorId,
              membership: member.membership,
              reasonCode: member.reasonCode,
              ordinal: member.ordinal,
            })),
          },
          rateMembers: {
            create: manifest.rateMembers.map((member) => ({
              rateSnapshotId: member.rateSnapshotId,
              corridorId: member.corridorId,
              capturedAt: member.capturedAt,
              ageMs: member.ageMs,
              eligibility: member.eligibility,
              reasonCode: member.reasonCode,
              ordinal: member.ordinal,
            })),
          },
          outcomeMembers: {
            create: manifest.outcomeMembers.map((member) => ({
              transferOutcomeId: member.transferOutcomeId,
              corridorId: member.corridorId,
              status: member.status,
              recordedAt: member.recordedAt,
              eligibility: member.eligibility,
              reasonCode: member.reasonCode,
              ordinal: member.ordinal,
            })),
          },
        },
        select: { id: true, manifestSchemaVersion: true },
      });

      return Object.freeze({
        id: persisted.id,
        anchorSlug: persisted.anchor.slug,
        computedAt: new Date(persisted.computedAt.getTime()),
        manifestId: storedManifest.id,
        manifestSchemaVersion: storedManifest.manifestSchemaVersion,
      });
    });
  },
});

/**
 * Read-only inspection path for persisted evidence-set manifests. It performs
 * bounded reads only: no live SEP calls, no recalculation, and no writes.
 * Legacy evaluations have no manifest row and surface as `null`, which the
 * formatter maps to explicit legacy/unknown lineage rather than inferred
 * membership.
 */
export const PRISMA_REPUTATION_MANIFEST_REPOSITORY: ReputationManifestRepository =
  Object.freeze({
    async readManifest(evaluationId) {
      if (!UUID_PATTERN.test(evaluationId)) return null;
      const { db } = await import("@/lib/dbClient");
      const row = await db.reputationEvidenceManifest.findUnique({
        where: { id: evaluationId },
        select: MANIFEST_SELECT,
      });
      return row === null ? null : toManifestRecord(row);
    },

    async readLatestManifestForAnchor(anchorSlug) {
      const { db } = await import("@/lib/dbClient");
      const row = await db.reputationEvidenceManifest.findFirst({
        where: { anchor: { slug: anchorSlug } },
        orderBy: [
          { evaluatedAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: MANIFEST_SELECT,
      });
      return row === null ? null : toManifestRecord(row);
    },
  });

function toManifestRecord(row: ManifestRow): ReputationManifestRecord {
  return Object.freeze({
    id: row.id,
    reputationScoreId: row.reputationScoreId,
    anchorSlug: row.anchor.slug,
    anchorStatus: row.anchorStatus,
    manifestSchemaVersion: row.manifestSchemaVersion,
    reasonCodeVocabularyVersion: row.reasonCodeVocabularyVersion,
    scoringPolicyVersion: row.scoringPolicyVersion,
    freshnessPolicyVersion: row.freshnessPolicyVersion,
    configurationRevision: row.configurationRevision,
    evaluatedAt: row.evaluatedAt.toISOString(),
    outcomeWindowStart: row.outcomeWindowStart.toISOString(),
    corridorCount: row.corridorCount,
    latestRateCount: row.latestRateCount,
    freshRateCount: row.freshRateCount,
    outcomeCount: row.outcomeCount,
    completedOutcomeCount: row.completedOutcomeCount,
    outsideOutcomeCount: row.outsideOutcomeCount,
    minimumOutcomeCount: row.minimumOutcomeCount,
    createdAt: row.createdAt.toISOString(),
    corridorMembers: Object.freeze(row.corridorMembers.map((member) =>
      Object.freeze({ ...member }))),
    rateMembers: Object.freeze(row.rateMembers.map((member) =>
      Object.freeze({ ...member, capturedAt: member.capturedAt.toISOString() }))),
    outcomeMembers: Object.freeze(row.outcomeMembers.map((member) =>
      Object.freeze({ ...member, recordedAt: member.recordedAt.toISOString() }))),
  });
}
