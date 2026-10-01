import { PrismaClient } from "@/app/generated/prisma/client";
import { getDbForWorkload, SCHEDULED_WORKLOAD } from "@/lib/db/workloadAccessor";
import type {
  NormalizedRateObservation,
  PersistedRateSnapshot,
  RateSnapshotPersistenceResult,
  RateSnapshotRepository,
} from "@/types/rates";

export type RateSnapshotRepositoryDependencies = Readonly<{
  db?: PrismaClient;
}>;

async function getDb(dependencies: RateSnapshotRepositoryDependencies = {}): Promise<PrismaClient> {
  return dependencies.db ?? getDbForWorkload(SCHEDULED_WORKLOAD);
}

export async function persistRateSnapshot(
  observation: NormalizedRateObservation,
  repository: RateSnapshotRepository = PRISMA_RATE_SNAPSHOT_REPOSITORY,
  dependencies: RateSnapshotRepositoryDependencies = {},
): Promise<RateSnapshotPersistenceResult> {
  try {
    const db = await getDb(dependencies);
    const anchor = await repository.findAnchorBySlug(observation.anchorSlug, { db });
    if (!anchor) return failure("ANCHOR_NOT_FOUND");
    const corridor = await repository.findCorridorBySlug(observation.corridorSlug, { db });
    if (!corridor) return failure("CORRIDOR_NOT_FOUND");
    if (!(await repository.hasAssociation(anchor.id, corridor.id, { db }))) {
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
    }, { db });
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
    return Object.freeze({ ok: true, snapshot });
  } catch {
    return failure("PERSISTENCE_FAILURE");
  }
}

export const PRISMA_RATE_SNAPSHOT_REPOSITORY: RateSnapshotRepository =
  Object.freeze({
  async findAnchorBySlug(slug, dependencies: RateSnapshotRepositoryDependencies = {}) {
    const db = await getDb(dependencies);
    return db.anchor.findUnique({ where: { slug }, select: { id: true } });
  },
  async findCorridorBySlug(slug, dependencies: RateSnapshotRepositoryDependencies = {}) {
    const db = await getDb(dependencies);
    return db.corridor.findUnique({ where: { slug }, select: { id: true } });
  },
  async hasAssociation(anchorId, corridorId, dependencies: RateSnapshotRepositoryDependencies = {}) {
    const db = await getDb(dependencies);
    return (await db.anchorCorridor.findUnique({
      where: { anchorId_corridorId: { anchorId, corridorId } },
      select: { anchorId: true },
    })) !== null;
  },
  async createSnapshot(input, dependencies: RateSnapshotRepositoryDependencies = {}) {
    const db = await getDb(dependencies);
    return db.rateSnapshot.create({
      data: input,
      select: {
        id: true,
        rate: true,
        sourceAmount: true,
        destinationAmount: true,
        fee: true,
        capturedAt: true,
      },
    });
  },
});

function failure(
  code: Exclude<RateSnapshotPersistenceResult, { ok: true }>["code"],
): RateSnapshotPersistenceResult {
  return Object.freeze({ ok: false, code });
}
