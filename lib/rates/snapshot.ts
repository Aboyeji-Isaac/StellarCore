import { deriveObservationKey } from "@/lib/rates/observationIdentity";
import type {
  NormalizedRateObservation,
  PersistedRateSnapshot,
  RateSnapshotPersistenceResult,
  RateSnapshotRepository,
} from "@/types/rates";

export async function persistRateSnapshot(
  observation: NormalizedRateObservation,
  repository: RateSnapshotRepository = PRISMA_RATE_SNAPSHOT_REPOSITORY,
): Promise<RateSnapshotPersistenceResult> {
  try {
    const anchor = await repository.findAnchorBySlug(observation.anchorSlug);
    if (!anchor) return failure("ANCHOR_NOT_FOUND");
    const corridor = await repository.findCorridorBySlug(observation.corridorSlug);
    if (!corridor) return failure("CORRIDOR_NOT_FOUND");
    if (!(await repository.hasAssociation(anchor.id, corridor.id))) {
      return failure("ASSOCIATION_NOT_FOUND");
    }

    const row = await repository.createSnapshot({
      anchorId: anchor.id,
      corridorId: corridor.id,
      rate: observation.rate,
      sourceAmount: observation.sourceAmount,
      destinationAmount: observation.destinationAmount,
      fee: observation.fee,
      capturedAt: observation.capturedAt,
      observationKey: deriveObservationKey(observation),
    });
    const snapshot: PersistedRateSnapshot = Object.freeze({
      id: row.id,
      anchorSlug: observation.anchorSlug,
      corridorSlug: observation.corridorSlug,
      rate: row.rate.toString(),
      sourceAmount: row.sourceAmount.toString(),
      destinationAmount: row.destinationAmount.toString(),
      fee: row.fee.toString(),
      capturedAt: new Date(row.capturedAt.getTime()),
    });
    return Object.freeze({ ok: true, snapshot, replayed: row.replayed === true });
  } catch {
    return failure("PERSISTENCE_FAILURE");
  }
}

export const PRISMA_RATE_SNAPSHOT_REPOSITORY: RateSnapshotRepository =
  Object.freeze({
  async findAnchorBySlug(slug) {
    const { db } = await import("@/lib/dbClient");
    return db.anchor.findUnique({ where: { slug }, select: { id: true } });
  },
  async findCorridorBySlug(slug) {
    const { db } = await import("@/lib/dbClient");
    return db.corridor.findUnique({ where: { slug }, select: { id: true } });
  },
  async hasAssociation(anchorId, corridorId) {
    const { db } = await import("@/lib/dbClient");
    return (await db.anchorCorridor.findUnique({
      where: { anchorId_corridorId: { anchorId, corridorId } },
      select: { anchorId: true },
    })) !== null;
  },
  async createSnapshot(input) {
    const { db } = await import("@/lib/dbClient");
    // INSERT ... ON CONFLICT DO NOTHING on the unique observation_key: safe
    // under concurrent runs and under retries after an ambiguous result.
    const { count } = await db.rateSnapshot.createMany({
      data: [input],
      skipDuplicates: true,
    });
    const row = await db.rateSnapshot.findUniqueOrThrow({
      where: { observationKey: input.observationKey },
      select: {
        id: true,
        rate: true,
        sourceAmount: true,
        destinationAmount: true,
        fee: true,
        capturedAt: true,
      },
    });
    return { ...row, replayed: count === 0 };
  },
});

function failure(
  code: Exclude<RateSnapshotPersistenceResult, { ok: true }>["code"],
): RateSnapshotPersistenceResult {
  return Object.freeze({ ok: false, code });
}
