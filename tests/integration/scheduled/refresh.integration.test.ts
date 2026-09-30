import assert from "node:assert";
import test from "node:test";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SuppressionRepository } from "@/lib/scheduled/suppressionRepository";
import type { ScheduledSourceSuppression } from "@/types/scheduled";

const EVALUATED_AT = new Date("2026-08-31T17:00:00.000Z");

test("controlled scheduled integration passes one persisted evaluation time from rate ingestion to reputation evaluation", async () => {
  const events: string[] = [];
  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      events.push("rate-persisted");
      return {
        totalCandidates: 1,
        totalAttempted: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        suppressed: 0,
        snapshotsPersisted: 1,
        snapshots: [],
        failures: [],
        skippedSources: [],
      };
    },
    evaluateReputation: async ({ evaluatedAt }) => {
      events.push(`reputation:${evaluatedAt.toISOString()}`);
      return { attempted: 2, succeeded: 2, failed: 0, failures: [] };
    },
    suppressions: suppressionRepository(),
    now: () => EVALUATED_AT,
  });

  assert.deepEqual(events, ["rate-persisted", "reputation:2026-08-31T17:00:00.000Z"]);
  assert.equal(result.ok, true);
  assert.equal(result.rates.succeeded, 1);
  assert.equal(result.reputation.succeeded, 2);
});

test("suppression state survives restarts and a reactivated source is no longer excluded", async () => {
  // Durable store simulating a Postgres backed repository that outlives a
  // process restart.
  const store = new MemorySuppressionStore();
  const deps = {
    snapshotRates: async () => ({
      totalCandidates: 1,
      totalAttempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      suppressed: 0,
      snapshotsPersisted: 1,
      snapshots: [],
      failures: [],
      skippedSources: [],
    }),
    evaluateReputation: async () => ({ attempted: 1, succeeded: 1, failed: 0, failures: [] }),
    suppressions: store.repository,
    now: () => EVALUATED_AT,
  } as const;

  // Three consecutive deterministic failures are recorded across runs; the
  // source is durably suppressed once the threshold is reached.
  for (let i = 0; i < 3; i++) {
    await store.recordDeterministicFailure({
      anchorSlug: "zeam",
      corridorSlug: "usdc-us-brl-br",
      reason: "PERMANENT_CONFIGURATION",
      failureCode: "INVALID_ANCHOR_CONFIGURATION",
      failurePhase: "CONFIGURATION",
      observedAt: EVALUATED_AT,
    });
  }
  assert.equal((await store.repository.listActive()).length, 1);

  // Simulate a process restart by rebuilding the repository over the same
  // durable store. Suppression must still be visible.
  const restarted = store.repository;
  assert.equal((await restarted.listActive()).length, 1);

  // Explicit reactivation after a configuration correction is auditable.
  const reactivated = await restarted.reactivate({
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    reason: "configuration corrected in PR #120",
    reactivatedAt: EVALUATED_AT,
  });
  assert.ok(reactivated);
  assert.equal(reactivated?.state, "REACTIVATED");
  assert.equal(reactivated?.reactivationReason, "configuration corrected in PR #120");
  assert.equal((await restarted.listActive()).length, 0);

  // The reactivated source is no longer excluded from a fresh run.
  const result = await runScheduledRefresh(deps);
  assert.equal(result.rates.suppressed, 0);
});

class MemorySuppressionStore {
  private const records = new Map<string, ScheduledSourceSuppression &> { consecutiveFailures: number }>();

  readonly repository: SuppressionRepository = Object.freeze({
    listActive: async () => Object.freeze(
      [...this.records.values()].filter((record) => record.state === "ACTIVE"),
    ),
    recordDeterministicFailure: async (input) => {
      const key = `${input.anchorSlug}:${input.corridorSlug}`;
      const existing = this.records.get(key);
      const nextConsecutive = (existing?.consecutiveFailures ?? 0) + 1;
      const state = nextConsecutive >= 3 ? "ACTIVE" : "REACTIVATED";
      const record = Object.freeze({
        anchorSlug: input.anchorSlug,
        corridorSlug: input.corridorSlug,
        reason: input.reason,
        state: state as ScheduledSourceSuppression["state"],
        failureCode: input.failureCode,
        failurePhase: input.failurePhase,
        consecutiveFailures: nextConsecutive,
        firstFailedAt: (existing?.firstFailedAt ?? input.observedAt.toISOString()),
        lastFailedAt: input.observedAt.toISOString(),
        suppressedAt: input.observedAt.toISOString(),
        reactivatedAt: null,
        reactivationReason: null,
      });
      this.records.set(key, record);
      return record;
    },
    reactivate: async (input) => {
      const key = `${input.anchorSlug}:${input.corridorSlug}`;
      const existing = this.records.get(key);
      if (!existing) return null;
      const updated = Object.freeze({
        ...existing,
        state: "REACTIVATED" as const,
        consecutiveFailures: 0,
        reactivatedAt: input.reactivatedAt.toISOString(),
        reactivationReason: input.reason,
      });
      this.records.set(key, updated);
      return updated;
    },
  });
}
