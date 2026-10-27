import {
  getAnchorApiResult,
  getAnchorsApiResult,
} from "@/lib/api/anchors";
import type {
  AnchorDetailRecord,
  AnchorDirectoryRecord,
  AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
import {
  getCorridorApiResult,
  getCorridorsApiResult,
} from "@/lib/api/corridors";
import type {
  CorridorDetailRecord,
  CorridorDetailRepository,
  CorridorDirectoryRecord,
  CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import { getRatesApiResult } from "@/lib/api/rates";
import {
  getAnchorReputationApiResult,
  getReputationApiResult,
} from "@/lib/api/reputation";
import type {
  ReputationApiAnchorRecord,
  ReputationApiRepository,
} from "@/lib/api/reputationRepository";
import type { LatestCorridorRate } from "@/types/latestRates";

export const CANONICAL_FIXED_TIMESTAMP = "2026-08-28T12:00:00.000Z";
export const CANONICAL_FIXED_DATE = new Date(CANONICAL_FIXED_TIMESTAMP);

export type ExecutionResult = Readonly<{
  status: number;
  body: unknown;
}>;

// --- Canonical Data Fixtures ---

export function getCanonicalAnchorRecords(): readonly AnchorDirectoryRecord[] {
  return Object.freeze([
    Object.freeze({
      slug: "cowrie",
      name: "Cowrie",
      homeDomain: "cowrie.example",
      status: "LIVE" as const,
      seps: Object.freeze([1, 24, 31]),
      corridorCount: 2,
    }),
    Object.freeze({
      slug: "moneygram",
      name: "MoneyGram",
      homeDomain: "moneygram.example",
      status: "LIVE" as const,
      seps: Object.freeze([1, 24]),
      corridorCount: 1,
    }),
    Object.freeze({
      slug: "zeam",
      name: "Zeam",
      homeDomain: "zeam.example",
      status: "LIVE" as const,
      seps: Object.freeze([1, 10, 24, 31, 38]),
      corridorCount: 2,
    }),
  ]);
}

export function getCanonicalAnchorDetailRecord(): AnchorDetailRecord {
  return Object.freeze({
    slug: "zeam",
    name: "Zeam",
    homeDomain: "zeam.example",
    status: "LIVE" as const,
    seps: Object.freeze([1, 10, 24, 31, 38]),
    corridorCount: 2,
    corridors: Object.freeze([
      Object.freeze({
        slug: "ngnt-ng-ngn-ng",
        assetCodeFrom: "NGNT",
        countryFrom: "NG",
        assetCodeTo: "NGN",
        countryTo: "NG",
      }),
      Object.freeze({
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      }),
    ]),
  });
}

export function getCanonicalCorridorRecords(): readonly CorridorDirectoryRecord[] {
  return Object.freeze([
    Object.freeze({
      slug: "ngnt-ng-ngn-ng",
      assetCodeFrom: "NGNT",
      countryFrom: "NG",
      assetCodeTo: "NGN",
      countryTo: "NG",
      anchorCount: 1,
    }),
    Object.freeze({
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
      anchorCount: 2,
    }),
  ]);
}

export function getCanonicalCorridorDetailRecord(): CorridorDetailRecord {
  return Object.freeze({
    slug: "usdc-us-brl-br",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchors: Object.freeze([
      Object.freeze({
        slug: "cowrie",
        name: "Cowrie",
        homeDomain: "cowrie.example",
        status: "LIVE" as const,
        seps: Object.freeze([1, 24, 31]),
      }),
      Object.freeze({
        slug: "zeam",
        name: "Zeam",
        homeDomain: "zeam.example",
        status: "LIVE" as const,
        seps: Object.freeze([1, 10, 24, 31, 38]),
      }),
    ]),
  });
}

export function getCanonicalReputationRecords(): readonly ReputationApiAnchorRecord[] {
  return Object.freeze([
    Object.freeze({
      slug: "cowrie",
      name: "Cowrie",
      reputationScore: Object.freeze({
        compositeScore: null,
        scoreBand: null,
        fillRate7d: null,
        fillRate30d: null,
        fillRate90d: null,
        settleP50Ms: null,
        settleP95Ms: null,
        slippageP50: null,
        slippageP95: null,
        sampleSize: 5,
        state: "INSUFFICIENT_DATA" as const,
        computedAt: CANONICAL_FIXED_DATE,
      }),
    }),
    Object.freeze({
      slug: "moneygram",
      name: "MoneyGram",
      reputationScore: null,
    }),
    Object.freeze({
      slug: "zeam",
      name: "Zeam",
      reputationScore: Object.freeze({
        compositeScore: 95,
        scoreBand: "GREEN" as const,
        fillRate7d: 0.98,
        fillRate30d: 0.95,
        fillRate90d: 0.94,
        settleP50Ms: 1200,
        settleP95Ms: 4500,
        slippageP50: 0.001,
        slippageP95: 0.015,
        sampleSize: 30,
        state: "OK" as const,
        computedAt: CANONICAL_FIXED_DATE,
      }),
    }),
  ]);
}

// --- Dispatchers ---

export async function executeEndpointScenario(
  fixtureName: string,
): Promise<ExecutionResult> {
  switch (fixtureName) {
    // Anchors
    case "anchors.list.success": {
      const records = getCanonicalAnchorRecords();
      const repo: AnchorDirectoryRepository = {
        findAll: async () => records,
        findBySlug: async () => null,
      };
      const res = await getAnchorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "anchors.list.empty": {
      const repo: AnchorDirectoryRepository = {
        findAll: async () => [],
        findBySlug: async () => null,
      };
      const res = await getAnchorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "anchors.list.error_500": {
      const repo: AnchorDirectoryRepository = {
        findAll: async () => {
          throw new Error("DB failure");
        },
        findBySlug: async () => null,
      };
      const res = await getAnchorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "anchors.detail.success": {
      const detail = getCanonicalAnchorDetailRecord();
      const repo: AnchorDirectoryRepository = {
        findAll: async () => [],
        findBySlug: async (slug) => (slug === "zeam" ? detail : null),
      };
      const res = await getAnchorApiResult("zeam", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "anchors.detail.error_400": {
      const res = await getAnchorApiResult("bad--slug");
      return { status: res.status, body: res.body };
    }
    case "anchors.detail.error_404": {
      const repo: AnchorDirectoryRepository = {
        findAll: async () => [],
        findBySlug: async () => null,
      };
      const res = await getAnchorApiResult("unknown-anchor", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "anchors.detail.error_500": {
      const repo: AnchorDirectoryRepository = {
        findAll: async () => [],
        findBySlug: async () => {
          throw new Error("DB failure");
        },
      };
      const res = await getAnchorApiResult("zeam", { repository: repo });
      return { status: res.status, body: res.body };
    }

    // Corridors
    case "corridors.list.success": {
      const records = getCanonicalCorridorRecords();
      const repo: CorridorDirectoryRepository = {
        findAll: async () => records,
      };
      const res = await getCorridorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.list.empty": {
      const repo: CorridorDirectoryRepository = {
        findAll: async () => [],
      };
      const res = await getCorridorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.list.error_500": {
      const repo: CorridorDirectoryRepository = {
        findAll: async () => {
          throw new Error("DB failure");
        },
      };
      const res = await getCorridorsApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.detail.success": {
      const detail = getCanonicalCorridorDetailRecord();
      const repo: CorridorDetailRepository = {
        findBySlug: async (slug) => (slug === "usdc-us-brl-br" ? detail : null),
      };
      const res = await getCorridorApiResult("usdc-us-brl-br", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.detail.empty_anchors": {
      const detail: CorridorDetailRecord = Object.freeze({
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
        anchors: Object.freeze([]),
      });
      const repo: CorridorDetailRepository = {
        findBySlug: async (slug) => (slug === "usdc-us-brl-br" ? detail : null),
      };
      const res = await getCorridorApiResult("usdc-us-brl-br", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.detail.error_400": {
      const res = await getCorridorApiResult("bad--slug");
      return { status: res.status, body: res.body };
    }
    case "corridors.detail.error_404": {
      const repo: CorridorDetailRepository = {
        findBySlug: async () => null,
      };
      const res = await getCorridorApiResult("unknown-corridor", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "corridors.detail.error_500": {
      const repo: CorridorDetailRepository = {
        findBySlug: async () => {
          throw new Error("DB failure");
        },
      };
      const res = await getCorridorApiResult("usdc-us-brl-br", { repository: repo });
      return { status: res.status, body: res.body };
    }

    // Rates
    case "rates.healthy.success": {
      const rateData: LatestCorridorRate = Object.freeze({
        ok: true,
        corridor: Object.freeze({
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        }),
        evaluatedAt: CANONICAL_FIXED_TIMESTAMP,
        state: "healthy" as const,
        median: "5.250000000000000000",
        totalIndependentSources: 2,
        freshSourceCount: 2,
        observations: Object.freeze([
          Object.freeze({
            snapshotId: "cowrie-snapshot",
            anchorSlug: "cowrie",
            anchorName: "Cowrie",
            rate: "5.240000000000000000",
            sourceAmount: "100.000000000000000000",
            destinationAmount: "524.000000000000000000",
            fee: "1.000000000000000000",
            capturedAt: "2026-08-28T11:59:50.000Z",
            freshnessState: "fresh" as const,
            ageMs: 10000,
            included: true,
          }),
          Object.freeze({
            snapshotId: "zeam-snapshot",
            anchorSlug: "zeam",
            anchorName: "Zeam",
            rate: "5.260000000000000000",
            sourceAmount: "100.000000000000000000",
            destinationAmount: "526.000000000000000000",
            fee: "1.500000000000000000",
            capturedAt: "2026-08-28T11:59:45.000Z",
            freshnessState: "fresh" as const,
            ageMs: 15000,
            included: true,
          }),
        ]),
        exclusions: Object.freeze([]),
      });

      const res = await getRatesApiResult("usdc-us-brl-br", {
        now: () => CANONICAL_FIXED_DATE,
        readLatestRate: async () => rateData,
      });
      return { status: res.status, body: res.body };
    }
    case "rates.insufficient.success": {
      const rateData: LatestCorridorRate = Object.freeze({
        ok: true,
        corridor: Object.freeze({
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        }),
        evaluatedAt: CANONICAL_FIXED_TIMESTAMP,
        state: "insufficient_fresh_sources" as const,
        median: null,
        totalIndependentSources: 2,
        freshSourceCount: 1,
        observations: Object.freeze([
          Object.freeze({
            snapshotId: "cowrie-snapshot",
            anchorSlug: "cowrie",
            anchorName: "Cowrie",
            rate: "5.240000000000000000",
            sourceAmount: "100.000000000000000000",
            destinationAmount: "524.000000000000000000",
            fee: "1.000000000000000000",
            capturedAt: "2026-08-28T11:59:50.000Z",
            freshnessState: "fresh" as const,
            ageMs: 10000,
            included: true,
          }),
          Object.freeze({
            snapshotId: "zeam-snapshot",
            anchorSlug: "zeam",
            anchorName: "Zeam",
            rate: "5.100000000000000000",
            sourceAmount: "100.000000000000000000",
            destinationAmount: "510.000000000000000000",
            fee: "1.500000000000000000",
            capturedAt: "2026-08-28T11:55:00.000Z",
            freshnessState: "stale" as const,
            ageMs: 300000,
            included: false,
            exclusionReason: "stale" as const,
          }),
        ]),
        exclusions: Object.freeze([]),
      });

      const res = await getRatesApiResult("usdc-us-brl-br", {
        now: () => CANONICAL_FIXED_DATE,
        readLatestRate: async () => rateData,
      });
      return { status: res.status, body: res.body };
    }
    case "rates.empty.success": {
      const rateData: LatestCorridorRate = Object.freeze({
        ok: true,
        corridor: Object.freeze({
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        }),
        evaluatedAt: CANONICAL_FIXED_TIMESTAMP,
        state: "insufficient_fresh_sources" as const,
        median: null,
        totalIndependentSources: 0,
        freshSourceCount: 0,
        observations: Object.freeze([]),
        exclusions: Object.freeze([]),
      });

      const res = await getRatesApiResult("usdc-us-brl-br", {
        now: () => CANONICAL_FIXED_DATE,
        readLatestRate: async () => rateData,
      });
      return { status: res.status, body: res.body };
    }
    case "rates.error_400_missing": {
      const res = await getRatesApiResult(null);
      return { status: res.status, body: res.body };
    }
    case "rates.error_400_invalid": {
      const res = await getRatesApiResult("bad--slug");
      return { status: res.status, body: res.body };
    }
    case "rates.error_404": {
      const res = await getRatesApiResult("unknown-corridor", {
        readLatestRate: async (slug) => ({
          ok: false,
          corridorSlug: slug,
          code: "CORRIDOR_NOT_FOUND",
        }),
      });
      return { status: res.status, body: res.body };
    }
    case "rates.error_500": {
      const res = await getRatesApiResult("usdc-us-brl-br", {
        readLatestRate: async () => {
          throw new Error("Rates DB failure");
        },
      });
      return { status: res.status, body: res.body };
    }

    // Reputation
    case "reputation.list.success": {
      const records = getCanonicalReputationRecords();
      const repo: ReputationApiRepository = {
        findAll: async () => records,
        findBySlug: async () => null,
      };
      const res = await getReputationApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.list.empty": {
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async () => null,
      };
      const res = await getReputationApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.list.error_500": {
      const repo: ReputationApiRepository = {
        findAll: async () => {
          throw new Error("DB failure");
        },
        findBySlug: async () => null,
      };
      const res = await getReputationApiResult({ repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.established_200": {
      const records = getCanonicalReputationRecords();
      const zeam = records.find((r) => r.slug === "zeam")!;
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async (slug) => (slug === "zeam" ? zeam : null),
      };
      const res = await getAnchorReputationApiResult("zeam", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.insufficient_200": {
      const records = getCanonicalReputationRecords();
      const cowrie = records.find((r) => r.slug === "cowrie")!;
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async (slug) => (slug === "cowrie" ? cowrie : null),
      };
      const res = await getAnchorReputationApiResult("cowrie", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.not_evaluated_200": {
      const records = getCanonicalReputationRecords();
      const moneygram = records.find((r) => r.slug === "moneygram")!;
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async (slug) => (slug === "moneygram" ? moneygram : null),
      };
      const res = await getAnchorReputationApiResult("moneygram", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.error_400": {
      const res = await getAnchorReputationApiResult("bad--slug");
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.error_404": {
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async () => null,
      };
      const res = await getAnchorReputationApiResult("unknown-anchor", { repository: repo });
      return { status: res.status, body: res.body };
    }
    case "reputation.detail.error_500": {
      const repo: ReputationApiRepository = {
        findAll: async () => [],
        findBySlug: async () => {
          throw new Error("DB failure");
        },
      };
      const res = await getAnchorReputationApiResult("zeam", { repository: repo });
      return { status: res.status, body: res.body };
    }

    default:
      throw new Error(`Unknown compatibility fixture: ${fixtureName}`);
  }
}
