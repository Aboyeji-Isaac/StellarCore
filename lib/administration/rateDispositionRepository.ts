import { appendOperatorAction } from "@/lib/audit/recordOperatorAction";
import type { RateDispositionRepository } from "@/lib/administration/rateDisposition";
import type { RateSnapshotTarget } from "@/types/administration";

/**
 * Prisma implementation. Both mutating methods open one transaction that
 * appends the immutable ledger row and changes the disposition state together,
 * and neither ever updates or deletes a historical RateSnapshot row.
 */
export const PRISMA_RATE_DISPOSITION_REPOSITORY: RateDispositionRepository = Object.freeze({
  async findSnapshot(snapshotId): Promise<RateSnapshotTarget | null> {
    const { db } = await import("@/lib/dbClient");
    const row = await db.rateSnapshot.findUnique({
      where: { id: snapshotId },
      select: {
        id: true,
        capturedAt: true,
        anchor: { select: { slug: true } },
        corridor: { select: { slug: true } },
      },
    });
    if (!row) return null;

    return Object.freeze({
      snapshotId: row.id,
      anchorSlug: row.anchor.slug,
      corridorSlug: row.corridor.slug,
      capturedAt: new Date(row.capturedAt.getTime()),
    });
  },

  async findDisposition(snapshotId) {
    const { db } = await import("@/lib/dbClient");
    const row = await db.rateSnapshotDisposition.findUnique({
      where: { snapshotId },
      select: { disposition: true },
    });
    return row?.disposition ?? null;
  },

  async applyDisposition(input) {
    const { db } = await import("@/lib/dbClient");
    try {
      return await db.$transaction(async (transaction) => {
        const existing = await transaction.rateSnapshotDisposition.findUnique({
          where: { snapshotId: input.snapshot.snapshotId },
          select: { id: true },
        });
        if (existing) return { ok: false as const, code: "ALREADY_DISPOSED" as const };

        const action = await appendOperatorAction(transaction, input.action);

        await transaction.rateSnapshotDisposition.create({
          data: {
            snapshotId: input.snapshot.snapshotId,
            disposition: input.disposition,
            reasonCode: action.reasonCode,
            rationale: action.rationale,
            actorType: action.actorType,
            actorId: action.actorId,
            runId: action.runId,
            actionRecordId: action.id,
          },
        });

        return { ok: true as const, disposition: input.disposition, action };
      });
    } catch (error) {
      // Only a collision on the disposition's own snapshot id is an
      // ALREADY_DISPOSED race. Any other failure (such as a duplicate audit
      // action id) rolls back and propagates rather than being mislabeled.
      if (isDispositionUniqueViolation(error)) {
        return { ok: false as const, code: "ALREADY_DISPOSED" as const };
      }
      throw error;
    }
  },

  async clearDisposition(input) {
    const { db } = await import("@/lib/dbClient");
    return db.$transaction(async (transaction) => {
      const existing = await transaction.rateSnapshotDisposition.findUnique({
        where: { snapshotId: input.snapshot.snapshotId },
        select: { id: true },
      });
      if (!existing) return { ok: false as const, code: "NOT_DISPOSED" as const };

      const action = await appendOperatorAction(transaction, input.action);

      const removed = await transaction.rateSnapshotDisposition.deleteMany({
        where: { snapshotId: input.snapshot.snapshotId },
      });
      if (removed.count !== 1) {
        return { ok: false as const, code: "NOT_DISPOSED" as const };
      }

      return { ok: true as const, action };
    });
  },
});

function isDispositionUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; meta?: unknown };
  if (record.code !== "P2002") return false;

  const target = (record.meta as { target?: unknown } | null | undefined)?.target;
  if (Array.isArray(target)) {
    return target.some((value) => typeof value === "string" && value.toLowerCase().includes("snapshot_id"));
  }
  if (typeof target === "string") {
    return target.toLowerCase().includes("snapshot_id");
  }
  return false;
}
