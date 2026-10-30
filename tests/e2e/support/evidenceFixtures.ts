/**
 * Deterministic API fixtures for the persisted-evidence browser smoke tests
 * (Issue #361).
 *
 * These fixtures use the same public response types the Next.js server
 * components consume, so the browser tests exercise the real section views
 * without a database, network access, or production credentials.
 */

import type { AnchorsApiResult } from "@/types/api/anchors";
import type { CorridorsApiResult } from "@/types/api/corridors";
import type { RatesApiResult } from "@/types/api/rates";
import type { ReputationApiListResult } from "@/types/api/reputation";

export type EvidenceFixtureState = "ready" | "empty" | "error";

export const EVIDENCE_FIXTURE_STATES: readonly EvidenceFixtureState[] = Object.freeze([
  "ready",
  "empty",
  "error",
]);

export const RATE_CORRIDOR_LABEL = "USDC (US) → BRL (BR)";

export const READY_ANCHORS: AnchorsApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({
    anchors: Object.freeze([
      Object.freeze({
        slug: "alpha-anchor",
        name: "Alpha Anchor",
        homeDomain: "alpha.example",
        status: "LIVE" as const,
        seps: Object.freeze([1, 24, 38]),
        isTransferCapable: true,
        corridorCount: 1,
      }),
      Object.freeze({
        slug: "beta-anchor",
        name: "Beta Anchor",
        homeDomain: "beta.example",
        status: "DEGRADED" as const,
        seps: Object.freeze([1]),
        isTransferCapable: false,
        corridorCount: 1,
      }),
    ]),
    count: 2,
  }),
});

export const EMPTY_ANCHORS: AnchorsApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({ anchors: Object.freeze([]), count: 0 }),
});

export const FAILED_ANCHORS: AnchorsApiResult = Object.freeze({
  status: 500,
  body: Object.freeze({
    error: Object.freeze({ code: "internal_error" as const, message: "Unable to load anchors." }),
  }),
});

export const READY_CORRIDORS: CorridorsApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({
    corridors: Object.freeze([
      Object.freeze({
        slug: "usdc-us-brl-br",
        sourceAsset: "USDC",
        sourceCountry: "US",
        destinationAsset: "BRL",
        destinationCountry: "BR",
        anchorCount: 2,
      }),
    ]),
    count: 1,
  }),
});

export const EMPTY_CORRIDORS: CorridorsApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({ corridors: Object.freeze([]), count: 0 }),
});

export const FAILED_CORRIDORS: CorridorsApiResult = Object.freeze({
  status: 500,
  body: Object.freeze({
    error: Object.freeze({ code: "internal_error" as const, message: "Unable to load corridors." }),
  }),
});

export const READY_RATES: RatesApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({
    corridor: Object.freeze({
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: "2026-09-20T12:05:00.000Z",
    state: "healthy" as const,
    medianRate: "5.1234",
    sourceCount: 2,
    freshSourceCount: 2,
    reviewedCandidateConfiguration: Object.freeze({ candidateCount: 3, uniqueAnchorCount: 2 }),
    medianRequirement: Object.freeze({ minimumFreshIndependentSources: 2 }),
    observations: Object.freeze([
      Object.freeze({
        anchor: Object.freeze({ slug: "alpha-anchor", name: "Alpha Anchor" }),
        rate: "5.1000",
        sourceAmount: "100",
        destinationAmount: "510",
        fee: "0",
        capturedAt: "2026-09-20T12:00:00.000Z",
        freshness: Object.freeze({ state: "fresh" as const, ageMs: 300_000 }),
        eligibleForMedian: true,
      }),
      Object.freeze({
        anchor: Object.freeze({ slug: "beta-anchor", name: "Beta Anchor" }),
        rate: "5.1468",
        sourceAmount: "100",
        destinationAmount: "514.68",
        fee: "0",
        capturedAt: "2026-09-20T12:00:00.000Z",
        freshness: Object.freeze({ state: "fresh" as const, ageMs: 300_000 }),
        eligibleForMedian: true,
      }),
    ]),
  }),
});

export const EMPTY_RATES: RatesApiResult = Object.freeze({
  status: 200,
  body: Object.freeze({
    corridor: Object.freeze({
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: "2026-09-20T12:05:00.000Z",
    state: "insufficient_fresh_sources" as const,
    medianRate: null,
    sourceCount: 0,
    freshSourceCount: 0,
    reviewedCandidateConfiguration: Object.freeze({ candidateCount: 3, uniqueAnchorCount: 2 }),
    medianRequirement: Object.freeze({ minimumFreshIndependentSources: 2 }),
    observations: Object.freeze([]),
  }),
});

export const FAILED_RATES: RatesApiResult = Object.freeze({
  status: 500,
  body: Object.freeze({
    error: Object.freeze({ code: "internal_error" as const, message: "Unable to read rates." }),
  }),
});

export const READY_REPUTATION: ReputationApiListResult = Object.freeze({
  status: 200,
  body: Object.freeze({
    reputation: Object.freeze([
      Object.freeze({
        anchor: Object.freeze({ slug: "alpha-anchor", name: "Alpha Anchor" }),
        state: "established" as const,
        score: 87,
        scoreBand: "green" as const,
        evidence: Object.freeze({ outcomeCount: 42 }),
        metrics: Object.freeze({
          fillRate7d: 0.97,
          fillRate30d: 0.95,
          fillRate90d: 0.93,
          settleP50Ms: 4_100,
          settleP95Ms: 8_200,
          slippageP50: 0.004,
          slippageP95: 0.011,
        }),
        computedAt: "2026-09-20T12:04:00.000Z",
      }),
    ]),
    count: 1,
  }),
});

export const EMPTY_REPUTATION: ReputationApiListResult = Object.freeze({
  status: 200,
  body: Object.freeze({ reputation: Object.freeze([]), count: 0 }),
});

export const FAILED_REPUTATION: ReputationApiListResult = Object.freeze({
  status: 500,
  body: Object.freeze({
    error: Object.freeze({ code: "internal_error" as const, message: "Unable to load reputation." }),
  }),
});

export type EvidenceFixtures = Readonly<{
  anchors: AnchorsApiResult;
  corridors: CorridorsApiResult;
  rates: RatesApiResult;
  reputation: ReputationApiListResult;
}>;

export function evidenceFixtures(state: EvidenceFixtureState): EvidenceFixtures {
  switch (state) {
    case "ready":
      return Object.freeze({
        anchors: READY_ANCHORS,
        corridors: READY_CORRIDORS,
        rates: READY_RATES,
        reputation: READY_REPUTATION,
      });
    case "empty":
      return Object.freeze({
        anchors: EMPTY_ANCHORS,
        corridors: EMPTY_CORRIDORS,
        rates: EMPTY_RATES,
        reputation: EMPTY_REPUTATION,
      });
    case "error":
      return Object.freeze({
        anchors: FAILED_ANCHORS,
        corridors: FAILED_CORRIDORS,
        rates: FAILED_RATES,
        reputation: FAILED_REPUTATION,
      });
  }
}
