import type {
  NormalizedRateObservation,
  PersistedRateSnapshot,
  RateSnapshotPersistenceResult,
  RateSnapshotRepository,
} from "@/types/rates";

async function assertRateSnapshotEnvironment(): Promise<Readonly<{ ok: boolean }>> {
  try {
    const { ensureDatabaseEnvironment } = await import("@/lib/dbClient");
    await ensureDatabaseEnvironment();
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ ok: false });
  }
}

/**
 * Environment-verified database accessor (#143). Every Prisma repository
 * method that touches evidence awaits this instead of importing dbClient
 * directly, so the runtime/database identity check runs before the first
 * query. Injected repositories in tests never reach this boundary and stay
 * fully offline.
 */
async function evidenceDb(): Promise<
  | Readonly<{ ok: true; db: import("@/lib/dbClient").PrismaClient }>
  | Readonly<{ ok: false }>
> {
  const environment = await assertRateSnapshotEnvironment();
  if (!environment.ok) return Object.freeze({ ok: false });
  const { db } = await import("@/lib/dbClient");
  return Object.freeze({ ok: true, db });
}

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
    return Object.freeze({ ok: true, snapshot });
  } catch (error) {
    // Environment isolation (#143): a guard rejection at the repository
    // boundary surfaces as a distinct structured failure so callers and the
    // scheduled run summary can tell a misrouted runtime from an ordinary
    // persistence error.
    if (error instanceof EnvironmentIsolationRejection) {
      return failure("ENVIRONMENT_MISMATCH");
    }
    return failure("PERSISTENCE_FAILURE");
  }
}

export const PRISMA_RATE_SNAPSHOT_REPOSITORY: RateSnapshotRepository =
  Object.freeze({
  async findAnchorBySlug(slug) {
    const environment = await evidenceDb();
    if (!environment.ok) throw new EnvironmentIsolationRejection();
    return environment.db.anchor.findUnique({ where: { slug }, select: { id: true } });
  },
  async findCorridorBySlug(slug) {
    const environment = await evidenceDb();
    if (!environment.ok) throw new EnvironmentIsolationRejection();
    return environment.db.corridor.findUnique({ where: { slug }, select: { id: true } });
  },
  async hasAssociation(anchorId, corridorId) {
    const environment = await evidenceDb();
    if (!environment.ok) throw new EnvironmentIsolationRejection();
    return (await environment.db.anchorCorridor.findUnique({
      where: { anchorId_corridorId: { anchorId, corridorId } },
      select: { anchorId: true },
    })) !== null;
  },
  async createSnapshot(input) {
    const environment = await evidenceDb();
    if (!environment.ok) throw new EnvironmentIsolationRejection();
    return environment.db.rateSnapshot.create({
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

/** Sentinel distinguishing guard rejections from ordinary persistence errors. */
export class EnvironmentIsolationRejection extends Error {
  constructor() {
    super("ENVIRONMENT_MISMATCH");
    this.name = "EnvironmentIsolationRejection";
  }
}

function failure(
  code: Exclude<RateSnapshotPersistenceResult, { ok: true }>["code"],
): RateSnapshotPersistenceResult {
  return Object.freeze({ ok: false, code });
}
