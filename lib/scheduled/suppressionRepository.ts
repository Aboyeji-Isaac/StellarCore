import {
  advancePermanentSuppression,
  reactivatePermanentSuppression,
} from "@/lib/scheduled/suppression";
import type {
  ScheduledSourceIdentity,
  ScheduledSourceSuppression,
  ScheduledSuppressionFailureInput,
  ScheduledSuppressionReactivationInput,
} from "@/types/suppression";

export type SuppressionRepository = Readonly<{
  listSuppressed: () => Promise<readonly ScheduledSourceIdentity[]>;
  recordDeterministicFailure: (
    input: ScheduledSuppressionFailureInput,
  ) => Promise<ScheduledSourceSuppression>;
  reactivate: (
    input: ScheduledSuppressionReactivationInput,
  ) => Promise<ScheduledSourceSuppression | null>;
}>;

export const PRISMA_SUPPRESSION_REPOSITORY: SuppressionRepository = Object.freeze({
  async listSuppressed() {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.scheduledSourceSuppression.findMany({
      where: { state: "SUPPRESSED" },
      orderBy: [{ anchorSlug: "asc" }, { corridorSlug: "asc" }],
      select: { anchorSlug: true, corridorSlug: true },
    });
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  },

  async recordDeterministicFailure(input) {
    const { db } = await import("@/lib/dbClient");

    return db.$transaction(async (tx) => {
      const existing = await tx.scheduledSourceSuppression.findUnique({
        where: {
          anchorSlug_corridorSlug: {
            anchorSlug: input.anchorSlug,
            corridorSlug: input.corridorSlug,
          },
        },
      });

      const next = advancePermanentSuppression(
        existing
          ? {
              state: existing.state,
              consecutiveFailures: existing.consecutiveFailures,
              suppressedAt: existing.suppressedAt,
            }
          : null,
        input.observedAt,
      );

      const row = await tx.scheduledSourceSuppression.upsert({
        where: {
          anchorSlug_corridorSlug: {
            anchorSlug: input.anchorSlug,
            corridorSlug: input.corridorSlug,
          },
        },
        create: {
          anchorSlug: input.anchorSlug,
          corridorSlug: input.corridorSlug,
          state: next.state,
          reason: input.reason,
          failureCode: input.failureCode,
          failurePhase: input.failurePhase,
          consecutiveFailures: next.consecutiveFailures,
          firstFailedAt: input.observedAt,
          lastFailedAt: input.observedAt,
          suppressedAt: next.suppressedAt,
        },
        update: {
          state: next.state,
          reason: input.reason,
          failureCode: input.failureCode,
          failurePhase: input.failurePhase,
          consecutiveFailures: next.consecutiveFailures,
          lastFailedAt: input.observedAt,
          suppressedAt: next.suppressedAt,
          reactivatedAt: null,
          reactivationReason: null,
        },
      });

      return toSuppression(row);
    });
  },

  async reactivate(input) {
    const { db } = await import("@/lib/dbClient");
    const existing = await db.scheduledSourceSuppression.findUnique({
      where: {
        anchorSlug_corridorSlug: {
          anchorSlug: input.anchorSlug,
          corridorSlug: input.corridorSlug,
        },
      },
    });
    if (!existing) return null;
    if (!input.reason.trim()) {
      throw new Error("Suppression reactivation requires a reviewed reason");
    }

    const reset = reactivatePermanentSuppression();
    const row = await db.scheduledSourceSuppression.update({
      where: { id: existing.id },
      data: {
        state: reset.state,
        consecutiveFailures: reset.consecutiveFailures,
        suppressedAt: reset.suppressedAt,
        reactivatedAt: input.reactivatedAt,
        reactivationReason: input.reason.trim(),
      },
    });
    return toSuppression(row);
  },
});

function toSuppression(row: {
  anchorSlug: string;
  corridorSlug: string;
  state: "ACTIVE" | "SUPPRESSED";
  reason: string;
  failureCode: string;
  failurePhase: string;
  consecutiveFailures: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  suppressedAt: Date | null;
  reactivatedAt: Date | null;
  reactivationReason: string | null;
}): ScheduledSourceSuppression {
  return Object.freeze({
    anchorSlug: row.anchorSlug,
    corridorSlug: row.corridorSlug,
    state: row.state,
    reason: row.reason as ScheduledSourceSuppression["reason"],
    failureCode: row.failureCode,
    failurePhase: row.failurePhase,
    consecutiveFailures: row.consecutiveFailures,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    reactivatedAt: row.reactivatedAt?.toISOString() ?? null,
    reactivationReason: row.reactivationReason,
  });
}
