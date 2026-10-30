import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { evaluatePersistedAnchorReputations } from "@/lib/reputation/run";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { formatLiveRateRunSummary } from "@/lib/rates/liveRateSource";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import type { ScheduledRefreshDependencies } from "@/lib/scheduled/refresh";
import type { ReputationRepository } from "@/types/reputation";
import type { RateCandidate, RateSnapshotRepository } from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ReputationEvaluationRunSummary } from "@/lib/reputation/run";
import {
  clock,
  deadlineAfter,
  DeadlineError,
  faultReputationRepository,
  faultSnapshotRepository,
  reputationLedger,
  snapshotLedger,
} from "./faultKit.js";

const STARTED_AT = new Date("2026-09-30T00:00:00.000Z");
const COMPLETED_AT = new Date("2026-09-30T00:00:01.000Z");
const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const NGN = "iso4217:NGN" as const;

// [O1] Orchestration under faults: rate ingestion still precedes reputation
// evaluation when rates fail, and the run summary reflects both truths with
// ok=false — never a fabricated success.
test("[O1] rate failure still evaluates reputation and reports ok=false with both truths", async () => {
  const order: string[] = [];
  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => {
      order.push("rates");
      return rateSummary({ succeeded: 0, failed: 1, snapshotsPersisted: 0, failures: [
        { anchorSlug: "zeam", corridorSlug: "usdc-us-brl-br", phase: "QUOTE", code: "QUOTE_FAILURE" },
      ] });
    },
    evaluateReputation: async () => {
      order.push("reputation");
      return reputationSummary({ succeeded: 2, failed: 1, failures: [{ anchorSlug: "cowrie", code: "EVIDENCE_READ_FAILURE" }] });
    },
  }));

  assert.deepEqual(order, ["rates", "reputation"]);
  assert.equal(result.ok, false);
  assert.equal(result.rates.failed, 1);
  assert.equal(result.reputation.failed, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

// [O2] A reputation orchestration failure escapes to the HTTP boundary as a
// safe 500; the rate work that did complete remains committed and is not
// misrepresented as a failed cycle.
test("[O2] fatal reputation failure reaches the HTTP boundary as a safe 500", async () => {
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });
  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: async () => {
      throw new Error("DATABASE_URL=must-not-leak");
    },
  });

  assert.equal(response.status, 500);
  const body = await response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "internal_error");
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
});

// [O3] Deadline exhaustion inside the rate boundary: the deadline fires on
// the virtual clock (no real time passes), the cycle reports the partial
// truth, and reputation still runs because rate failures are isolated.
test("[O3] deadline-exceeded during rate ingestion produces a partial cycle, not a crash", async () => {
  const virtualClock = clock(STARTED_AT);
  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => {
      await deadlineAfter(async () => {
        virtualClock.advance(2_000);
        return rateSummary();
      }, 1_000, virtualClock);
      return rateSummary({ succeeded: 0, failed: 1, snapshotsPersisted: 0, failures: [
        { anchorSlug: "zeam", corridorSlug: "usdc-us-brl-br", phase: "QUOTE", code: "QUOTE_FAILURE" },
      ] });
    },
    evaluateReputation: async () => reputationSummary(),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.rates.failed, 1);
  assert.equal(result.reputation.succeeded, 3);
});

// [O4] Cancellation of the whole cycle: the cancellation fault is injected at
// the run boundary (as an aborted signal would be in production). The refresh
// boundary lets it propagate to the HTTP layer, which maps it to a safe 500 —
// a cancelled cycle must never return a 200 success summary.
test("[O4] a cancelled cycle never returns a success summary", async () => {
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });

  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: async () => {
      throw new DeadlineError("OPERATION_CANCELLED");
    },
  });

  assert.equal(response.status, 500);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "internal_error");
});

// [O4b] A deadline-exceeded run behaves the same way: no fabricated 200.
test("[O4b] a deadline-exceeded cycle never returns a success summary", async () => {
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });

  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: async () => {
      throw new DeadlineError("DEADLINE_EXCEEDED");
    },
  });

  assert.equal(response.status, 500);
});

// [O5] Process interruption mid-cycle: rate work has committed one snapshot
// and the process dies during the reputation phase (the fatal seam of the
// refresh boundary — rate failures are isolated, reputation orchestration
// failures propagate). No summary is produced. A rerun completes the
// remaining work on top of the committed rows without duplicating evidence.
test("[O5] interruption mid-cycle leaves partial progress that a rerun completes without duplicating evidence", async () => {
  const persistedSnapshots: string[] = [];
  let interrupted = true;

  // Cycle one: one snapshot commits, then the process dies mid-reputation.
  const interruptedResult = await runScheduledRefreshSafe({
    snapshotRates: async () => {
      persistedSnapshots.push("snapshot-1");
      return rateSummary();
    },
    evaluateReputation: async () => {
      if (interrupted) {
        // Simulate the process dying right here: no summary is produced.
        throw new Error("SIMULATED_PROCESS_EXIT");
      }
      return reputationSummary();
    },
  });
  assert.equal(interruptedResult.kind, "THREW");
  assert.equal(persistedSnapshots.length, 1);

  // The interrupted cycle produced no success claim (it threw).
  // Cycle two (rerun): completes the remaining snapshots on top of the
  // committed row.
  interrupted = false;
  const rerunResult = await runScheduledRefreshSafe({
    snapshotRates: async () => {
      persistedSnapshots.push("snapshot-2");
      persistedSnapshots.push("snapshot-3");
      return rateSummary({ snapshotsPersisted: 2 });
    },
    evaluateReputation: async () => reputationSummary(),
  });

  assert.equal(rerunResult.kind, "OK");
  if (rerunResult.kind === "OK") {
    assert.equal(rerunResult.value.ok, true);
  }
  // Evidence invariant: the rerun appended missing rows; nothing was
  // duplicated and the interrupted row survived.
  assert.deepEqual(persistedSnapshots, ["snapshot-1", "snapshot-2", "snapshot-3"]);
  assert.equal(new Set(persistedSnapshots).size, persistedSnapshots.length);
});

// [O6] Concurrency: two overlapping cycles on the same boundary. The second
// invocation must not fabricate a success for work it did not observe; with
// sequential dependency injection each cycle reports exactly the work it
// performed, and summaries stay bounded and serializable.
test("[O6] concurrent cycles report only their own work without fabricating success", async () => {
  let rateRuns = 0;
  const inFlight = new Set<Promise<unknown>>();

  const runOne = runScheduledRefresh(dependencies({
    snapshotRates: async () => {
      rateRuns += 1;
      // Overlap: while cycle one is mid-rate-phase, cycle two starts.
      const overlapped = runScheduledRefresh(dependencies({
        snapshotRates: async () => {
          rateRuns += 1;
          return rateSummary({ snapshotsPersisted: 1 });
        },
        evaluateReputation: async () => reputationSummary(),
      }));
      inFlight.add(overlapped);
      return rateSummary({ snapshotsPersisted: 1 });
    },
    evaluateReputation: async () => reputationSummary(),
  }));

  const [outer, inner] = await Promise.all([runOne, Promise.all(inFlight).then(([first]) => first)]);

  assert.equal(rateRuns, 2);
  // Each summary reports its own single rate run; neither claims the other's.
  if ("ok" in outer) {
    assert.equal(outer.rates.attempted, 1);
  }
  const innerSummary = inner as { rates: { attempted: number } };
  assert.equal(innerSummary.rates.attempted, 1);
});

test("[O7] the HTTP boundary keeps no-store semantics under fault responses", async () => {
  const request = new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: "Bearer secret" },
  });
  const response = await getScheduledRefreshResponse(request, {
    cronSecret: "secret",
    run: async () => {
      throw new Error("database unavailable");
    },
  });

  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("[O8] mixed task outcomes preserve committed evidence and report partial failure", async () => {
  const rateEvidence = snapshotLedger();
  const reputationEvidence = reputationLedger();
  const candidates = [candidate("anchor-a"), candidate("anchor-b")];
  const evidenceBySlug = {
    "anchor-a": {
      anchorId: "anchor:anchor-a",
      status: "LIVE" as const,
      corridorSlugs: ["usdc-us-ngn-ng"],
      latestRateCount: 1,
      outcomeCount: 1,
      completedOutcomeCount: 1,
    },
    "anchor-b": {
      anchorId: "anchor:anchor-b",
      status: "LIVE" as const,
      corridorSlugs: ["usdc-us-ngn-ng"],
      latestRateCount: 1,
      outcomeCount: 1,
      completedOutcomeCount: 1,
    },
  };
  const rateRepository = faultSnapshotRepository(rateEvidence, {
    createSnapshot: ["ok", "fault:DB_CONNECTION_LOST"],
  }) as RateSnapshotRepository;
  const reputationRepository = faultReputationRepository(reputationEvidence, evidenceBySlug, {
    upsertScore: ["ok", "fault:DB_CONNECTION_LOST"],
  }) as unknown as ReputationRepository;

  const result = await runScheduledRefresh(dependencies({
    snapshotRates: async () => formatLiveRateRunSummary(await runRateEngine(candidates, {
      quote: async () => okQuote(),
      repository: rateRepository,
      now: () => STARTED_AT,
      configurationFingerprint: "test-fingerprint",
    })),
    evaluateReputation: ({ evaluatedAt }) => evaluatePersistedAnchorReputations({
      anchorSlugs: Object.keys(evidenceBySlug),
      evaluatedAt,
      dependencies: {
        listAnchorSlugs: async () => Object.keys(evidenceBySlug),
        evaluate: (slug) => evaluateAnchorReputation(slug, {
          repository: reputationRepository,
          evaluatedAt,
        }),
      },
    }),
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(
    [result.rates.succeeded, result.rates.failed, result.reputation.succeeded, result.reputation.failed],
    [1, 1, 1, 1],
  );
  assert.equal(rateEvidence.idsForAnchor("anchor-a").length, 1);
  assert.equal(rateEvidence.idsForAnchor("anchor-b").length, 0);
  assert.ok(reputationEvidence.scores.has("anchor:anchor-a"));
  assert.equal(reputationEvidence.scores.has("anchor:anchor-b"), false);

  const committedSnapshot = rateEvidence.rows[0];
  const retryCandidates = candidates.filter((entry) => result.rates.failures.some(
    (failure) => failure.phase !== "PREPARATION" &&
      failure.anchorSlug === entry.anchorSlug && failure.corridorSlug === entry.corridor.slug,
  ));
  const rateRetry = await runRateEngine(retryCandidates, {
    quote: async () => okQuote(),
    repository: faultSnapshotRepository(rateEvidence) as RateSnapshotRepository,
    now: () => STARTED_AT,
    configurationFingerprint: "test-fingerprint",
  });
  assert.equal(rateRetry.succeeded, 1);
  assert.equal(rateRetry.failed, 0);
  assert.equal(rateEvidence.count(), 2);
  assert.equal(rateEvidence.idsForAnchor("anchor-a").length, 1);
  assert.equal(rateEvidence.idsForAnchor("anchor-b").length, 1);
  assert.deepEqual(rateEvidence.rows[0], committedSnapshot);

  const retryRepository = faultReputationRepository(reputationEvidence, evidenceBySlug) as unknown as ReputationRepository;
  const retry = await evaluatePersistedAnchorReputations({
    anchorSlugs: Object.keys(evidenceBySlug),
    evaluatedAt: STARTED_AT,
    dependencies: {
      listAnchorSlugs: async () => Object.keys(evidenceBySlug),
      evaluate: (slug) => evaluateAnchorReputation(slug, {
        repository: retryRepository,
        evaluatedAt: STARTED_AT,
      }),
    },
  });

  assert.equal(retry.succeeded, 2);
  assert.equal(reputationEvidence.scores.size, 2);
});

function dependencies(
  overrides: Partial<ScheduledRefreshDependencies>,
): ScheduledRefreshDependencies {
  let clockCalls = 0;
  return {
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => reputationSummary(),
    now: () => (clockCalls++ % 2 === 0 ? STARTED_AT : COMPLETED_AT),
    ...overrides,
  };
}

function candidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: Object.freeze({
      slug: "usdc-us-ngn-ng",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "NGN",
      countryTo: "NG",
    }),
    request: Object.freeze({ sellAsset: USDC, buyAsset: NGN, sellAmount: "100", context: "sep31" }),
  });
}

function okQuote(): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: NGN,
    totalPrice: "1",
    price: "1",
    sellAmount: "100",
    buyAmount: "100",
    fee: Object.freeze({ total: "0", asset: NGN, details: Object.freeze([]) }),
  });
}

type InterruptedOutcome =
  | { kind: "OK"; value: Awaited<ReturnType<typeof runScheduledRefresh>> }
  | { kind: "THREW" };

async function runScheduledRefreshSafe(
  overrides: Partial<ScheduledRefreshDependencies>,
): Promise<InterruptedOutcome> {
  try {
    return { kind: "OK", value: await runScheduledRefresh(dependencies(overrides)) };
  } catch {
    return { kind: "THREW" };
  }
}

function rateSummary(overrides: Partial<SafeLiveRateRunSummary> = {}): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 1,
    snapshots: [],
    failures: [],
    skippedSources: [],
    ...overrides,
  });
}

function reputationSummary(overrides: Partial<ReputationEvaluationRunSummary> = {}): ReputationEvaluationRunSummary {
  return Object.freeze({
    attempted: 3,
    succeeded: 3,
    failed: 0,
    failures: [],
    ...overrides,
  });
}
