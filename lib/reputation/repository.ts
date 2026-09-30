import { Prisma } from "@/app/generated/prisma/client";
import type {
  PersistedReputationScore,
  ReputationEvidenceReadResult,
  ReputationEvidenceSet,
  ReputationPersistenceInput,
  ReputationRepository,
} from "@/types/reputation";
import type { PrismaClient } from "@/app/generated/prisma/client";
import { REPUTATION_SNAPSHOT_ISOLATION_LEVEL } from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;
type SnapshotIdentityRow = Readonly<{ snapshot: string; snapshotAt: Date }>;

/**
 * Bounds the transient-failure retry budget so a degraded database cannot turn
 * into unbounded evaluation work (issue #135). Only errors that provably did
 * not observe an evaluation identity (connection/serialization) are retried.
 */
const SNAPSHOT_READ_MAX_ATTEMPTS = 3;
const SNAPSHOT_READ_RETRY_DELAY_MS = 50;
const SNAPSHOT_TRANSACTION_TIMEOUT_MS = 10_000;

export const PRISMA_REPUTATION_REPOSITORY: ReputationRepository = Object.freeze({
  async readEvidence(anchorSlug, outcomeWindowStart): Promise<ReputationEvidenceReadResult> {
    const { db } = await import("@/lib/dbClient");

    let lastFailure: ReputationEvidenceReadResult | null = null;
    for (let attempt = 1; attempt <= SNAPSHOT_READ_MAX_ATTEMPTS; attempt += 1) {
      let result: ReputationEvidenceReadResult;
      try {
        result = await readEvidenceSnapshot(db, anchorSlug, outcomeWindowStart);
      } catch (error) {
        if (!isTransientSnapshotFailure(error)) {
          return { ok: false, code: "SNAPSHOT_UNAVAILABLE" };
        }
        if (attempt === SNAPSHOT_READ_MAX_ATTEMPTS) {
          return { ok: false, code: "RETRY_EXHAUSTED" };
        }
        await delay(SNAPSHOT_READ_RETRY_DELAY_MS * attempt);
        continue;
      }
      if (result.ok || result.code === "ANCHOR_NOT_FOUND") return result;
      lastFailure ??= result;
    }
    return lastFailure ?? { ok: false, code: "SNAPSHOT_UNAVAILABLE" };
  },

  async upsertScore(input: ReputationPersistenceInput): Promise<PersistedReputationScore> {
    const { db } = await import("@/lib/dbClient");
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

/**
 * Reads every piece of one evaluation's evidence — anchor state, corridor
 * membership, latest per-corridor rate observations, and trailing-window
 * transfer outcomes — inside ONE explicit read-only RepeatableRead
 * PostgreSQL transaction (issue #135). PostgreSQL MVCC guarantees those reads
 * observe one consistent snapshot even if rate capture, registry
 * reconciliation, or outcome ingestion commit between the individual
 * statements; a torn evidence set cannot be produced.
 *
 * No external SEP/network request ever runs inside the transaction: the
 * transaction body only awaits database reads and closes before returning.
 */
async function readEvidenceSnapshot(
  db: PrismaClient,
  anchorSlug: string,
  outcomeWindowStart: Date,
): Promise<ReputationEvidenceReadResult> {
  const evidenceSet = await db.$transaction(
    async (tx) => {
      const anchor = await tx.anchor.findUnique({
        where: { slug: anchorSlug },
        select: {
          id: true,
          slug: true,
          status: true,
          corridors: { select: { corridor: { select: { slug: true } } } },
        },
      });
      if (!anchor) return null;

      const [latestRates, transferOutcomes, snapshotIdentity] = await Promise.all([
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
        // pg_current_snapshot() identifies this RepeatableRead observation
        // without assigning a write xid, so a read-only transaction keeps its
        // read-only access mode.
        tx.$queryRaw<SnapshotIdentityRow[]>(
          Prisma.sql`SELECT pg_current_snapshot()::text AS snapshot, transaction_timestamp() AS "snapshotAt"`,
        ),
      ]);

      const identity = snapshotIdentity[0];
      if (!identity) {
        throw new Error("REPUTATION_SNAPSHOT_IDENTITY_UNAVAILABLE");
      }

      const evidence = Object.freeze({
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
      }) satisfies ReputationEvidenceSet["evidence"];

      return Object.freeze({
        evidence,
        snapshot: Object.freeze({
          isolationLevel: REPUTATION_SNAPSHOT_ISOLATION_LEVEL,
          readOnly: true,
          transactionId: identity.snapshot,
          snapshotAt: identity.snapshotAt.toISOString(),
        }),
      }) satisfies ReputationEvidenceSet;
    },
    {
      isolationLevel: REPUTATION_SNAPSHOT_ISOLATION_LEVEL,
      maxWait: 5_000,
      timeout: SNAPSHOT_TRANSACTION_TIMEOUT_MS,
    },
  );

  if (evidenceSet === null) return { ok: false, code: "ANCHOR_NOT_FOUND" };
  return { ok: true, evidenceSet };
}

function isTransientSnapshotFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // PostgreSQL 40001 serialization_failure and 40P01 deadlock_detected are
    // the documented retryable snapshot classes; the transaction closed
    // without a usable snapshot, so retrying cannot change an observation.
    return error.code === "P2024" || error.code === "P2034";
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
