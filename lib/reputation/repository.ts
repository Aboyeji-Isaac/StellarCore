import { Prisma } from "@/app/generated/prisma/client";
import {
  readInReputationSnapshot,
  ReputationSnapshotAbort,
  type ReputationSnapshotFailure,
} from "@/lib/reputation/snapshot";
import type {
  PersistedReputationScore,
  ReputationEvidence,
  ReputationEvidenceReadFailure,
  ReputationPersistenceInput,
  ReputationRepository,
} from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;

/**
 * Reads the complete reputation evidence set from one PostgreSQL snapshot
 * (#135). The anchor row, corridor membership, latest per-corridor rate
 * observations, and the 90-day transfer-outcome window are all queried inside
 * a single explicit REPEATABLE READ transaction, so concurrent rate capture,
 * registry reconciliation, or outcome ingestion can never produce a torn
 * evidence set. Deterministic ordering is preserved per query.
 */
export const PRISMA_REPUTATION_REPOSITORY: ReputationRepository = Object.freeze({
  async readEvidence(anchorSlug, outcomeWindowStart) {
    const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
    // Environment isolation (#143): fail closed before any evidence access
    // when the runtime and database identities do not match.
    await ensureDatabaseEnvironment();
    const snapshotResult = await readInReputationSnapshot(db, (tx, identity) =>
      readEvidenceInSnapshot(tx, identity, anchorSlug, outcomeWindowStart),
    );
    if (!snapshotResult.ok) return toEvidenceReadFailure(snapshotResult.failure);
    return snapshotResult.value;
  },

  async upsertScore(input: ReputationPersistenceInput): Promise<PersistedReputationScore> {
    const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
    // Environment isolation (#143): same fail-closed gate for score writes.
    await ensureDatabaseEnvironment();
    const { calculation } = input;
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
    const persisted = await db.reputationScore.upsert({
      where: { anchorId: input.anchorId },
      create: { anchorId: input.anchorId, ...data },
      update: data,
      select: { id: true, computedAt: true, anchor: { select: { slug: true } } },
    });

    return Object.freeze({
      id: persisted.id,
      anchorSlug: persisted.anchor.slug,
      computedAt: new Date(persisted.computedAt.getTime()),
    });
  },
});

async function readEvidenceInSnapshot(
  tx: Prisma.TransactionClient,
  identity: Readonly<{ snapshotId: string; readAt: Date }>,
  anchorSlug: string,
  outcomeWindowStart: Date,
): Promise<ReputationEvidence> {
  const anchor = await tx.anchor.findUnique({
    where: { slug: anchorSlug },
    select: {
      id: true,
      slug: true,
      status: true,
      corridors: { select: { corridor: { select: { slug: true } } } },
    },
  });
  // The anchor was not visible in this snapshot; abort deterministically
  // without retry so callers receive a typed ANCHOR_NOT_FOUND outcome.
  if (!anchor) throw new ReputationSnapshotAbort();

  const [latestRates, transferOutcomes] = await Promise.all([
    tx.$queryRaw<LatestRateRow[]>(Prisma.sql`
        SELECT DISTINCT ON (corridor.slug)
          corridor.slug AS "corridorSlug",
          snapshot.captured_at AS "capturedAt"
        FROM rate_snapshots AS snapshot
        INNER JOIN corridors AS corridor ON corridor.id = snapshot.corridor_id
        WHERE snapshot.anchor_id = ${anchor.id}::uuid
        ORDER BY corridor.slug, snapshot.captured_at DESC, snapshot.id DESC
      `),
    tx.transferOutcome.findMany({
      where: { anchorId: anchor.id, recordedAt: { gte: outcomeWindowStart } },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      select: {
        status: true,
        settlementMs: true,
        slippage: true,
        recordedAt: true,
      },
    }),
  ]);

  return Object.freeze({
    anchorId: anchor.id,
    anchorSlug: anchor.slug,
    status: anchor.status,
    corridorSlugs: Object.freeze(anchor.corridors
      .map(({ corridor }) => corridor.slug)
      .sort((left, right) => left.localeCompare(right))),
    latestRates: Object.freeze(latestRates.map((rate) => Object.freeze({
      corridorSlug: rate.corridorSlug,
      capturedAt: new Date(rate.capturedAt.getTime()),
    }))),
    transferOutcomes: Object.freeze(transferOutcomes.map((outcome) =>
      Object.freeze({
        status: outcome.status,
        settlementMs: outcome.settlementMs,
        slippage: outcome.slippage,
        recordedAt: new Date(outcome.recordedAt.getTime()),
      }))),
    snapshot: Object.freeze({
      snapshotId: identity.snapshotId,
      readAt: new Date(identity.readAt.getTime()),
      isolationLevel: "REPEATABLE READ",
    }),
  });
}

// A missing anchor throws ReputationSnapshotAbort (from
// lib/reputation/snapshot.ts), which the snapshot boundary classifies as a
// deterministic (non-retryable) failure instead of a transient one.

function toEvidenceReadFailure(failure: ReputationSnapshotFailure): ReputationEvidenceReadFailure {
  return Object.freeze({
    code: failure.code,
    retryable: failure.retryable,
    attempts: failure.attempts,
  });
}
