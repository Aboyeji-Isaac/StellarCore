import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { getRatesApiResult } from "@/lib/api/rates";
import { getReputationApiResult } from "@/lib/api/reputation";
import { createFileStaleEvidenceStore, STALE_EVIDENCE_MAX_AGE_MS } from "@/lib/api/staleEvidence";
import type { ReputationApiAnchorRecord } from "@/lib/api/reputationRepository";
import type { CorridorRateHistory } from "@/types/rateHistory";
import type { LatestCorridorRate } from "@/types/latestRates";

const CORRIDOR = "usdc-us-brl-br";
const INITIAL = new Date("2026-09-20T12:00:00.000Z");
const SOURCE = new Date("2026-09-20T11:59:00.000Z");
const OUTAGE = Object.assign(new Error("database offline"), { code: "P1001" });

test("read-only evidence APIs serve verified stale snapshots during outage, fail after expiry, and recover immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-evidence-integration-"));
  const staleEvidenceStore = createFileStaleEvidenceStore(directory);
  const recoveredAt = new Date(INITIAL.getTime() + STALE_EVIDENCE_MAX_AGE_MS + 2_000);
  let ratesMode: "initial" | "outage" | "recovered" | "application-error" = "initial";
  let historyMode: "initial" | "outage" | "recovered" = "initial";
  let reputationMode: "initial" | "outage" | "recovered" = "initial";

  try {
    const rates = async (now: Date) => getRatesApiResult(CORRIDOR, {
      now: () => now,
      staleEvidenceStore,
      readLatestRate: async () => {
        if (ratesMode === "outage") throw OUTAGE;
        if (ratesMode === "application-error") throw new Error("unexpected application failure");
        return latestRate(ratesMode === "initial" ? "1.25" : "1.50", now);
      },
    });
    const history = async (now: Date) => getRateHistoryApiResult(CORRIDOR, "30", {
      now: () => now,
      staleEvidenceStore,
      readHistory: async () => {
        if (historyMode === "outage") throw OUTAGE;
        return rateHistory(historyMode === "initial" ? "1.25" : "1.50", now);
      },
    });
    const reputation = async (now: Date) => getReputationApiResult({
      now: () => now,
      staleEvidenceStore,
      repository: {
        findAll: async () => {
          if (reputationMode === "outage") throw OUTAGE;
          return [reputationRecord(reputationMode === "initial" ? 80 : 92, now)];
        },
        findBySlug: async () => null,
      },
    });

    const initialRates = await rates(INITIAL);
    const initialHistory = await history(INITIAL);
    const initialReputation = await reputation(INITIAL);
    assert.equal(initialRates.status, 200);
    assert.equal(initialHistory.status, 200);
    assert.equal(initialReputation.status, 200);
    if (initialRates.status !== 200 || initialHistory.status !== 200 || initialReputation.status !== 200) return;

    ratesMode = "application-error";
    assert.equal((await rates(new Date(INITIAL.getTime() + 500))).status, 500);
    ratesMode = "outage";
    historyMode = "outage";
    reputationMode = "outage";
    const staleAt = new Date(INITIAL.getTime() + 1_000);
    const staleRates = await rates(staleAt);
    const staleHistory = await history(staleAt);
    const staleReputation = await reputation(staleAt);

    assert.equal(staleRates.status, 200);
    assert.equal(staleHistory.status, 200);
    assert.equal(staleReputation.status, 200);
    if (staleRates.status !== 200 || staleHistory.status !== 200 || staleReputation.status !== 200) return;
    assert.equal(staleRates.degraded?.state, "stale");
    assert.equal(staleHistory.degraded?.state, "stale");
    assert.equal(staleReputation.degraded?.state, "stale");
    assert.equal(staleRates.body.medianRate, "1.25");
    assert.equal(staleRates.body.evaluatedAt, INITIAL.toISOString());
    assert.deepEqual(staleRates.degraded?.sourceTimes, [SOURCE.toISOString()]);

    const expiredAt = new Date(INITIAL.getTime() + STALE_EVIDENCE_MAX_AGE_MS);
    assert.equal((await rates(expiredAt)).status, 500);
    assert.equal((await history(expiredAt)).status, 500);
    assert.equal((await reputation(expiredAt)).status, 500);

    ratesMode = "recovered";
    historyMode = "recovered";
    reputationMode = "recovered";
    const recoveredRates = await rates(recoveredAt);
    const recoveredHistory = await history(recoveredAt);
    const recoveredReputation = await reputation(recoveredAt);
    assert.equal(recoveredRates.status, 200);
    assert.equal(recoveredHistory.status, 200);
    assert.equal(recoveredReputation.status, 200);
    if (recoveredRates.status !== 200 || recoveredHistory.status !== 200 || recoveredReputation.status !== 200) return;
    assert.equal(recoveredRates.degraded, undefined);
    assert.equal(recoveredHistory.degraded, undefined);
    assert.equal(recoveredReputation.degraded, undefined);
    assert.equal(recoveredRates.body.medianRate, "1.50");
    assert.equal(recoveredHistory.body.points[0]?.medianRate, "1.50");
    assert.equal(recoveredReputation.body.reputation[0]?.score, 92);

    ratesMode = "outage";
    historyMode = "outage";
    reputationMode = "outage";
    const staleAgain = await rates(new Date(recoveredAt.getTime() + 1_000));
    assert.equal(staleAgain.status, 200);
    if (staleAgain.status === 200) {
      assert.equal(staleAgain.degraded?.generatedAt, recoveredAt.toISOString());
      assert.equal(staleAgain.body.medianRate, "1.50");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function latestRate(rate: string, evaluatedAt: Date): LatestCorridorRate {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    evaluatedAt: evaluatedAt.toISOString(),
    state: "healthy",
    median: rate,
    totalIndependentSources: 1,
    freshSourceCount: 1,
    observations: Object.freeze([Object.freeze({
      snapshotId: `snapshot-${rate}`,
      anchorSlug: "anchor-a",
      anchorName: "Anchor A",
      rate,
      sourceAmount: "100",
      destinationAmount: rate === "1.25" ? "125" : "150",
      fee: "0",
      capturedAt: SOURCE.toISOString(),
      freshnessState: "fresh",
      ageMs: Math.max(0, evaluatedAt.getTime() - SOURCE.getTime()),
      included: true,
    })]),
    exclusions: Object.freeze([]),
  });
}

function rateHistory(rate: string, evaluatedAt: Date): CorridorRateHistory {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: evaluatedAt.toISOString(),
    windowDays: 30,
    points: Object.freeze([Object.freeze({
      timestamp: SOURCE.toISOString(),
      medianRate: rate,
      state: "healthy",
      sourceCount: 1,
      freshSourceCount: 1,
      observations: Object.freeze([Object.freeze({
        anchorSlug: "anchor-a",
        anchorName: "Anchor A",
        rate,
        sourceAmount: "100",
        destinationAmount: rate === "1.25" ? "125" : "150",
        fee: "0",
        capturedAt: SOURCE.toISOString(),
      })]),
    })]),
  });
}

function reputationRecord(score: number, now: Date): ReputationApiAnchorRecord {
  return Object.freeze({
    slug: "anchor-a",
    name: "Anchor A",
    reputationScore: Object.freeze({
      compositeScore: score,
      scoreBand: "GREEN",
      fillRate7d: 0.95,
      fillRate30d: 0.95,
      fillRate90d: 0.95,
      settleP50Ms: 1_000,
      settleP95Ms: 2_000,
      slippageP50: 0.01,
      slippageP95: 0.02,
      sampleSize: 10,
      state: "OK",
      computedAt: now,
    }),
  });
}
