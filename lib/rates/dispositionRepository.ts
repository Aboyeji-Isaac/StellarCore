import { Prisma } from "@/app/generated/prisma/client";
import type { DispositionAction, DispositionReason, DispositionSubject } from "@/lib/rates/disposition";

export type DispositionEventRecord = Readonly<{
  id: string;
  sequence: number;
  action: DispositionAction;
  reasonCode: DispositionReason;
  reviewReference: string;
  actor: string;
  note: string | null;
  supersededBySnapshotId: string | null;
  recordedAt: Date;
}>;

export type DispositionSnapshotRecord = DispositionSubject & Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  events: readonly DispositionEventRecord[];
}>;

export type NewDispositionEvent = Readonly<{
  snapshotId: string;
  sequence: number;
  action: DispositionAction;
  reasonCode: DispositionReason;
  reviewReference: string;
  actor: string;
  note?: string;
  supersededBySnapshotId?: string;
}>;

type Transaction = Prisma.TransactionClient;

/**
 * Disposition persistence. It exposes reads and a single append; there is
 * deliberately no update or delete, and the database rejects both. Rate
 * snapshots are only read here, never written.
 */
export type DispositionRepository = Readonly<{
  findSnapshot: (snapshotId: string) => Promise<DispositionSnapshotRecord | null>;
  /**
   * Runs `work` in one serializable transaction so a concurrent disposition
   * of the same snapshot cannot interleave between planning and append.
   */
  withTransaction: <T>(work: (tx: DispositionTransaction) => Promise<T>) => Promise<T>;
}>;

export type DispositionTransaction = Readonly<{
  findSnapshot: (snapshotId: string) => Promise<DispositionSnapshotRecord | null>;
  append: (event: NewDispositionEvent) => Promise<DispositionEventRecord>;
}>;

const EVENT_SELECT = {
  id: true,
  sequence: true,
  action: true,
  reasonCode: true,
  reviewReference: true,
  actor: true,
  note: true,
  supersededBySnapshotId: true,
  recordedAt: true,
} as const;

async function findSnapshotWith(
  client: Transaction,
  snapshotId: string,
): Promise<DispositionSnapshotRecord | null> {
  // Sequential flat queries: nested relation loading would issue parallel
  // queries on the single connection an interactive transaction holds.
  const snapshot = await client.rateSnapshot.findUnique({
    where: { id: snapshotId },
    select: { id: true, anchorId: true, corridorId: true, capturedAt: true, rate: true },
  });
  if (!snapshot) return null;
  const anchor = await client.anchor.findUniqueOrThrow({
    where: { id: snapshot.anchorId },
    select: { slug: true },
  });
  const corridor = await client.corridor.findUniqueOrThrow({
    where: { id: snapshot.corridorId },
    select: { slug: true },
  });
  const events = await client.rateObservationDisposition.findMany({
    where: { snapshotId },
    orderBy: { sequence: "asc" },
    select: EVENT_SELECT,
  });
  const last = events.at(-1);
  return Object.freeze({
    id: snapshot.id,
    anchorId: snapshot.anchorId,
    corridorId: snapshot.corridorId,
    capturedAt: snapshot.capturedAt,
    anchorSlug: anchor.slug,
    corridorSlug: corridor.slug,
    rate: snapshot.rate.toString(),
    lastAction: last?.action ?? null,
    lastSequence: last?.sequence ?? 0,
    events: Object.freeze(events.map((event) => Object.freeze({ ...event }))),
  });
}

export const PRISMA_DISPOSITION_REPOSITORY: DispositionRepository = Object.freeze({
  async findSnapshot(snapshotId) {
    const { db } = await import("@/lib/dbClient");
    return findSnapshotWith(db, snapshotId);
  },

  async withTransaction(work) {
    const { db } = await import("@/lib/dbClient");
    return db.$transaction((tx) => work(Object.freeze({
      findSnapshot: (snapshotId: string) => findSnapshotWith(tx, snapshotId),
      append: async (event: NewDispositionEvent) => Object.freeze(
        await tx.rateObservationDisposition.create({
          data: {
            snapshotId: event.snapshotId,
            sequence: event.sequence,
            action: event.action,
            reasonCode: event.reasonCode,
            reviewReference: event.reviewReference,
            actor: event.actor,
            note: event.note ?? null,
            supersededBySnapshotId: event.supersededBySnapshotId ?? null,
          },
          select: EVENT_SELECT,
        }),
      ),
    })), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  },
});
