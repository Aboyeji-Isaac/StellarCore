import assert from "node:assert/strict";
import test from "node:test";

import { runRateEngine } from "@/lib/rates/rateEngine";
import type {
  RateCandidate,
  RateSnapshotRepository,
} from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USD = "iso4217:USD" as const;
const NOW = new Date("2026-08-27T12:00:00.000Z");

function candidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: Object.freeze({ slug: "usdc-us-usd-us", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "USD", countryTo: "US" }),
    request: Object.freeze({ sellAsset: USDC, buyAsset: USD, sellAmount: "100", context: "sep31" }),
  });
}

function quote(overrides: Partial<Sep38IndicativePrice> = {}): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1",
    price: "1",
    sellAmount: "100",
    buyAmount: "100",
    fee: Object.freeze({ total: "0", asset: USD, details: Object.freeze([]) }),
    ...overrides,
  });
}

test("duplicate anchor/corridor candidates are skipped within one run", async () => {
  let quoteCalls = 0;
  const result = await runRateEngine([candidate("moneygram"), candidate("moneygram")], {
    quote: async () => { quoteCalls += 1; return quote(); },
    repository: repository(),
    now: () => NOW,
  });
  assert.equal(quoteCalls, 1);
  assert.deepEqual({ attempted: result.totalAttempted, succeeded: result.succeeded, skipped: result.skipped }, {
    attempted: 1,
    succeeded: 1,
    skipped: 1,
  });
  assert.equal(result.skippedSources[0]?.reason, "DUPLICATE_CANDIDATE");
});

test("quote and normalization failures are isolated and safely classified", async () => {
  const result = await runRateEngine(
    [candidate("quote-fails"), candidate("normalize-fails"), candidate("succeeds")],
    {
      quote: async (source) => {
        if (source.anchorSlug === "quote-fails") throw new Error("Bearer secret");
        if (source.anchorSlug === "normalize-fails") return quote({ price: "0" });
        return quote();
      },
      repository: repository(),
      now: () => NOW,
    },
  );
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.failures.map(({ anchorSlug, phase, code }) => ({ anchorSlug, phase, code })), [
    { anchorSlug: "quote-fails", phase: "QUOTE", code: "QUOTE_FAILURE" },
    { anchorSlug: "normalize-fails", phase: "NORMALIZATION", code: "INVALID_RATE" },
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("persistence failure does not prevent a later source from succeeding", async () => {
  const base = repository();
  const store: RateSnapshotRepository = {
    ...base,
    createSnapshot: async (input) => {
      if (input.anchorId === "broken") throw new Error("DATABASE_URL=secret");
      return base.createSnapshot(input);
    },
    findAnchorBySlug: async (slug) => ({ id: slug === "broken" ? "broken" : slug }),
  };
  const result = await runRateEngine([candidate("broken"), candidate("healthy")], {
    quote: async () => quote(),
    repository: store,
    now: () => NOW,
  });
  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.failures, [{
    anchorSlug: "broken",
    corridorSlug: "usdc-us-usd-us",
    phase: "PERSISTENCE",
    code: "PERSISTENCE_FAILURE",
  }]);
});

function repository(): RateSnapshotRepository {
  let count = 0;
  return {
    findAnchorBySlug: async (slug) => ({ id: slug }),
    findCorridorBySlug: async (slug) => ({ id: slug }),
    hasAssociation: async () => true,
    createSnapshot: async (input) => ({ id: `snapshot-${++count}`, ...input }),
  };
}
