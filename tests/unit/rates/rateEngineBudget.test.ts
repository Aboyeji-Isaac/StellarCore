import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { runRateEngine } from "@/lib/rates/rateEngine";
import type { RateCandidate, RateSnapshotRepository } from "@/types/rates";
import type { Sep38IndicativePrice } from "@/types/sep38";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const USD = "iso4217:USD" as const;
const NOW = new Date("2026-08-27T12:00:00.000Z");
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const hang = (): Promise<never> => new Promise<never>(() => undefined);

function candidate(anchorSlug: string): RateCandidate {
  return Object.freeze({
    anchorSlug,
    corridor: Object.freeze({ slug: "usdc-us-usd-us", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "USD", countryTo: "US" }),
    request: Object.freeze({ sellAsset: USDC, buyAsset: USD, sellAmount: "100", context: "sep31" }),
  });
}

function quote(): Sep38IndicativePrice {
  return Object.freeze({
    sellAsset: USDC,
    buyAsset: USD,
    totalPrice: "1",
    price: "1",
    sellAmount: "100",
    buyAmount: "100",
    fee: Object.freeze({ total: "0", asset: USD, details: Object.freeze([]) }),
  });
}

function repository(rows: { anchorId: string }[] = []): RateSnapshotRepository {
  return {
    findAnchorBySlug: async (slug) => ({ id: slug }),
    findCorridorBySlug: async (slug) => ({ id: slug }),
    hasAssociation: async () => true,
    createSnapshot: async (input) => {
      rows.push({ anchorId: input.anchorId });
      return { id: `snapshot-${rows.length}`, ...input };
    },
  };
}

test("a hung source times out, is reported, and creates no snapshot while others succeed", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rows: { anchorId: string }[] = [];
    const pending = runRateEngine([candidate("hung"), candidate("a"), candidate("b")], {
      quote: async (source) => (source.anchorSlug === "hung" ? hang() : quote()),
      repository: repository(rows),
      now: () => NOW,
      budget: { concurrency: 2, perSourceMs: 1_000, runMs: 10_000 },
    });
    await tick();
    mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(result.succeeded, 2);
    assert.deepEqual(result.failures, [{
      anchorSlug: "hung",
      corridorSlug: "usdc-us-usd-us",
      phase: "CAPTURE_BUDGET",
      code: "SOURCE_TIMEOUT",
    }]);
    assert.deepEqual(rows.map((r) => r.anchorId), ["a", "b"]);
  } finally {
    mock.timers.reset();
  }
});

test("a quote that settles after its timeout never persists a snapshot", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rows: { anchorId: string }[] = [];
    let release: (value: Sep38IndicativePrice) => void = () => undefined;
    const pending = runRateEngine([candidate("slow")], {
      quote: () => new Promise<Sep38IndicativePrice>((resolve) => { release = resolve; }),
      repository: repository(rows),
      now: () => NOW,
      budget: { concurrency: 1, perSourceMs: 500, runMs: 10_000 },
    });
    await tick();
    mock.timers.tick(500);
    release(quote());
    const result = await pending;
    await tick();
    assert.equal(result.snapshotsPersisted, 0);
    assert.equal(rows.length, 0);
    assert.equal(result.failures[0]?.code, "SOURCE_TIMEOUT");
  } finally {
    mock.timers.reset();
  }
});

test("run deadline, not-started and source timeout are distinct typed results", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = runRateEngine([candidate("hung"), candidate("x"), candidate("y")], {
      quote: async () => hang(),
      repository: repository(),
      now: () => NOW,
      budget: { concurrency: 1, perSourceMs: 5_000, runMs: 3_000 },
    });
    await tick();
    mock.timers.tick(3_000);
    const result = await pending;
    assert.deepEqual(result.failures.map((f) => f.code), ["RUN_DEADLINE_EXCEEDED", "NOT_STARTED", "NOT_STARTED"]);
    assert.equal(result.snapshotsPersisted, 0);
  } finally {
    mock.timers.reset();
  }
});

test("engine never exceeds the configured concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const slugs = ["a", "b", "c", "d", "e", "f"];
  const result = await runRateEngine(slugs.map(candidate), {
    quote: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return quote();
    },
    repository: repository(),
    now: () => NOW,
    budget: { concurrency: 2, perSourceMs: 5_000, runMs: 50_000 },
  });
  assert.equal(peak, 2);
  assert.equal(result.succeeded, 6);
});
test("the quote provider receives a signal that aborts when its source times out", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let seen: AbortSignal | undefined;
    const pending = runRateEngine([candidate("hung")], {
      quote: (_source, signal) => { seen = signal; return hang(); },
      repository: repository(),
      now: () => NOW,
      budget: { concurrency: 1, perSourceMs: 500, runMs: 10_000 },
    });
    await tick();
    assert.equal(seen?.aborted, false);
    mock.timers.tick(500);
    await pending;
    assert.equal(seen?.aborted, true);
  } finally {
    mock.timers.reset();
  }
});
