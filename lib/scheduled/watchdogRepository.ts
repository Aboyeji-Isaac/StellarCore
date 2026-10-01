import { Prisma } from "@/app/generated/prisma/client";
import type {
  RefreshRunOutcome,
  RefreshWatchdogRepository,
  RefreshWatchdogState,
} from "@/types/refreshWatchdog";

type WatchdogRow = Readonly<{
  pipeline: string;
  trackingSince: Date;
  lastRunId: string | null;
  lastRunStartedAt: Date | null;
  lastRunCompletedAt: Date | null;
  lastRunOutcome: "SUCCESSFUL" | "PARTIAL" | "FAILED" | null;
  lastRunFailureCode: string | null;
  lastSuccessfulRefreshAt: Date | null;
  consecutiveUnsuccessfulRuns: number;
}>;

const SELECT = {
  pipeline: true,
  trackingSince: true,
  lastRunId: true,
  lastRunStartedAt: true,
  lastRunCompletedAt: true,
  lastRunOutcome: true,
  lastRunFailureCode: true,
  lastSuccessfulRefreshAt: true,
  consecutiveUnsuccessfulRuns: true,
} as const;

/**
 * Row-lock statement for one serialized watchdog transition. Exported for the
 * reviewed raw-SQL boundary parameterization tests: values are Prisma-bound
 * parameters and the statement structure is constant.
 */
export const watchdogPipelineLockQuery = (pipeline: string) =>
  Prisma.sql`SELECT 1 FROM refresh_watchdog WHERE pipeline = ${pipeline} FOR UPDATE`;

/**
 * Persists the watchdog heartbeat in PostgreSQL. Each transition runs in one
 * transaction holding a row lock, so concurrent completions serialize instead
 * of losing an update. This is not the #111 refresh lock: it only protects this
 * one row for the duration of a tiny write.
 */
export const PRISMA_REFRESH_WATCHDOG_REPOSITORY: RefreshWatchdogRepository = Object.freeze({
  async read(pipeline) {
    const { db } = await import("@/lib/dbClient");
    const row = await db.refreshWatchdog.findUnique({ where: { pipeline }, select: SELECT });
    return row ? toState(row) : null;
  },

  async transition(pipeline, apply) {
    const { db } = await import("@/lib/dbClient");
    return db.$transaction(async (tx) => {
      await tx.$executeRaw(watchdogPipelineLockQuery(pipeline));
      const row = await tx.refreshWatchdog.findUnique({ where: { pipeline }, select: SELECT });
      const next = apply(row ? toState(row) : null);
      const data = {
        trackingSince: next.trackingSince,
        lastRunId: next.lastRunId,
        lastRunStartedAt: next.lastRunStartedAt,
        lastRunCompletedAt: next.lastRunCompletedAt,
        lastRunOutcome: next.lastRunOutcome ? TO_PRISMA[next.lastRunOutcome] : null,
        lastRunFailureCode: next.lastRunFailureCode,
        lastSuccessfulRefreshAt: next.lastSuccessfulRefreshAt,
        consecutiveUnsuccessfulRuns: next.consecutiveUnsuccessfulRuns,
      };
      const saved = await tx.refreshWatchdog.upsert({
        where: { pipeline },
        create: { pipeline, ...data },
        update: data,
        select: SELECT,
      });
      return toState(saved);
    });
  },
});

const TO_PRISMA = Object.freeze({
  successful: "SUCCESSFUL",
  partial: "PARTIAL",
  failed: "FAILED",
} as const satisfies Record<RefreshRunOutcome, WatchdogRow["lastRunOutcome"]>);

const FROM_PRISMA = Object.freeze({
  SUCCESSFUL: "successful",
  PARTIAL: "partial",
  FAILED: "failed",
} as const satisfies Record<NonNullable<WatchdogRow["lastRunOutcome"]>, RefreshRunOutcome>);

function toState(row: WatchdogRow): RefreshWatchdogState {
  return Object.freeze({
    pipeline: row.pipeline,
    trackingSince: new Date(row.trackingSince.getTime()),
    lastRunId: row.lastRunId,
    lastRunStartedAt: copy(row.lastRunStartedAt),
    lastRunCompletedAt: copy(row.lastRunCompletedAt),
    lastRunOutcome: row.lastRunOutcome ? FROM_PRISMA[row.lastRunOutcome] : null,
    lastRunFailureCode: row.lastRunFailureCode,
    lastSuccessfulRefreshAt: copy(row.lastSuccessfulRefreshAt),
    consecutiveUnsuccessfulRuns: row.consecutiveUnsuccessfulRuns,
  });
}

function copy(value: Date | null): Date | null {
  return value ? new Date(value.getTime()) : null;
}
