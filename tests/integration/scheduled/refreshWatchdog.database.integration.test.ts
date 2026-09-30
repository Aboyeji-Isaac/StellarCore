import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { applyRunCompleted, applyRunStarted, evaluateRefreshWatchdog } from "@/lib/scheduled/watchdog";
import { PRISMA_REFRESH_WATCHDOG_REPOSITORY } from "@/lib/scheduled/watchdogRepository";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REFRESH_WATCHDOG_DATABASE_INTEGRATION === "1";

test("watchdog heartbeat is durable, serialized, and never touches evidence tables", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const pipeline = `test-watchdog-${randomUUID()}`;
  const repository = PRISMA_REFRESH_WATCHDOG_REPOSITORY;
  const startedAt = new Date("2026-09-30T00:00:00.000Z");
  const completedAt = new Date("2026-09-30T00:00:10.000Z");
  const evidenceBefore = await evidenceCounts(db);

  try {
    assert.equal(await repository.read(pipeline), null);
    await repository.transition(pipeline, (current) =>
      applyRunStarted(current, pipeline, randomUUID(), startedAt));
    const runId = (await repository.read(pipeline))!.lastRunId!;

    await Promise.all([
      repository.transition(pipeline, (current) => applyRunCompleted(
        current, pipeline, { runId, startedAt, completedAt },
        { outcome: "successful", failureCode: null },
      )),
      repository.transition(pipeline, (current) => applyRunCompleted(
        current, pipeline,
        { runId: randomUUID(), startedAt: new Date(startedAt.getTime() - 60_000), completedAt },
        { outcome: "failed", failureCode: "REFRESH_FATAL" },
      )),
    ]);

    // A fresh read is what a restarted process sees: nothing but the row.
    const reloaded = await repository.read(pipeline);
    assert.equal(reloaded?.lastRunOutcome, "successful");
    assert.equal(reloaded?.lastSuccessfulRefreshAt?.toISOString(), completedAt.toISOString());
    assert.equal(reloaded?.consecutiveUnsuccessfulRuns, 0);
    assert.equal(evaluateRefreshWatchdog(reloaded, completedAt, pipeline).state, "fresh");
    assert.equal(
      evaluateRefreshWatchdog(reloaded, new Date("2026-10-01T02:00:00.001Z"), pipeline).state,
      "stale",
    );

    await repository.transition(pipeline, (current) => applyRunCompleted(
      current, pipeline,
      { runId: randomUUID(), startedAt: completedAt, completedAt: new Date("2026-10-01T00:00:05.000Z") },
      { outcome: "partial", failureCode: "RATE_SOURCE_FAILURES" },
    ));
    const afterPartial = await repository.read(pipeline);
    assert.equal(afterPartial?.lastRunOutcome, "partial");
    assert.equal(afterPartial?.lastSuccessfulRefreshAt?.toISOString(), completedAt.toISOString());

    assert.deepEqual(await evidenceCounts(db), evidenceBefore);
    const seeded = await repository.read("scheduled-refresh");
    assert.ok(seeded, "migration seeds the production pipeline row");
  } finally {
    await db.refreshWatchdog.deleteMany({ where: { pipeline } });
  }
});

async function evidenceCounts(db: typeof import("@/lib/dbClient").db) {
  const [snapshots, scores, outcomes] = await Promise.all([
    db.rateSnapshot.count(),
    db.reputationScore.count(),
    db.transferOutcome.count(),
  ]);
  return { snapshots, scores, outcomes };
}
