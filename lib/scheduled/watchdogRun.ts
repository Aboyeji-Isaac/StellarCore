import { randomUUID } from "node:crypto";

import { REFRESH_PIPELINE } from "@/constants/refresh";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import {
  applyRunCompleted,
  applyRunStarted,
  classifyRefreshRun,
  evaluateRefreshWatchdog,
  type RefreshRunClassification,
} from "@/lib/scheduled/watchdog";
import { PRISMA_REFRESH_WATCHDOG_REPOSITORY } from "@/lib/scheduled/watchdogRepository";
import type { RefreshWatchdogRepository, RefreshWatchdogStatus } from "@/types/refreshWatchdog";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type WatchedRefreshDependencies = Readonly<{
  run: () => Promise<ScheduledRefreshResult>;
  repository: RefreshWatchdogRepository;
  now: () => Date;
  runId: () => string;
}>;

/**
 * Runs one scheduler cycle and records it in the durable watchdog. The start
 * is recorded before any work; the outcome is recorded only after the cycle
 * finishes and is classified by the evidence it produced. A watchdog write
 * failure never blocks or fails the refresh itself: it is reported as
 * `recorded: false`, and because the heartbeat did not advance, the watchdog
 * fails towards stale rather than towards fresh.
 */
export async function runWatchedScheduledRefresh(
  dependencies: WatchedRefreshDependencies = DEFAULT_DEPENDENCIES,
): Promise<ScheduledRefreshResult> {
  const runId = dependencies.runId();
  const startedAt = dependencies.now();
  await attempt(() => dependencies.repository.transition(
    REFRESH_PIPELINE,
    (current) => applyRunStarted(current, REFRESH_PIPELINE, runId, startedAt),
  ));

  let result: ScheduledRefreshResult;
  try {
    result = await dependencies.run();
  } catch (error) {
    await recordCompletion(dependencies, runId, startedAt, Object.freeze({
      outcome: "failed",
      failureCode: "REFRESH_FATAL",
    }));
    throw error;
  }

  const classification = classifyRefreshRun(result);
  const recorded = await recordCompletion(dependencies, runId, startedAt, classification);
  return Object.freeze({
    ...result,
    watchdog: Object.freeze({ outcome: classification.outcome, recorded }),
  });
}

/** Operator read model. Reads only watchdog state; never writes evidence. */
export async function readRefreshWatchdogStatus(
  dependencies: Readonly<{
    repository?: RefreshWatchdogRepository;
    now?: () => Date;
  }> = {},
): Promise<RefreshWatchdogStatus> {
  const repository = dependencies.repository ?? PRISMA_REFRESH_WATCHDOG_REPOSITORY;
  const now = dependencies.now?.() ?? new Date();
  return evaluateRefreshWatchdog(await repository.read(REFRESH_PIPELINE), now, REFRESH_PIPELINE);
}

async function recordCompletion(
  dependencies: WatchedRefreshDependencies,
  runId: string,
  startedAt: Date,
  classification: RefreshRunClassification,
): Promise<boolean> {
  const completedAt = dependencies.now();
  return attempt(() => dependencies.repository.transition(
    REFRESH_PIPELINE,
    (current) => applyRunCompleted(
      current,
      REFRESH_PIPELINE,
      { runId, startedAt, completedAt },
      classification,
    ),
  ));
}

async function attempt(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  run: () => runScheduledRefresh(),
  repository: PRISMA_REFRESH_WATCHDOG_REPOSITORY,
  now: () => new Date(),
  runId: () => randomUUID(),
}) satisfies WatchedRefreshDependencies;
