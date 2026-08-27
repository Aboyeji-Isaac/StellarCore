import assert from "node:assert/strict";
import test from "node:test";

import { computeFreshMedian } from "@/lib/rates/median";
import { runRateEngine } from "@/lib/rates/rateEngine";
import type { RateCandidate, RateSnapshotRepository } from "@/types/rates";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" as const;
const NGN = "iso4217:NGN" as const;
const NOW = new Date("2026-08-27T12:00:00.000Z");

test("controlled quote to normalization to persistence to median composition stays offline", async () => {
  const rows: Awaited<ReturnType<RateSnapshotRepository["createSnapshot"]>>[] = [];
  const repository: RateSnapshotRepository = {
    findAnchorBySlug: async (slug) => ({ id: `anchor:${slug}` }),
    findCorridorBySlug: async (slug) => ({ id: `corridor:${slug}` }),
    hasAssociation: async () => true,
    createSnapshot: async (input) => {
      const row = { id: `snapshot-${rows.length + 1}`, ...input };
      rows.push(row);
      return row;
    },
  };
  const candidates = [source("anchor-a"), source("anchor-b")];
  const result = await runRateEngine(candidates, {
    quote: async (candidate) => ({
      sellAsset: USDC,
      buyAsset: NGN,
      totalPrice: candidate.anchorSlug === "anchor-a" ? "1600" : "1610",
      price: candidate.anchorSlug === "anchor-a" ? "1600" : "1610",
      sellAmount: "1",
      buyAmount: candidate.anchorSlug === "anchor-a" ? "1600" : "1610",
      fee: { total: "0", asset: NGN, details: [] },
    }),
    repository,
    now: () => NOW,
  });
  const median = computeFreshMedian(result.snapshots.map((snapshot) => ({
    anchorSlug: snapshot.anchorSlug,
    corridorSlug: snapshot.corridorSlug,
    rate: snapshot.rate,
    capturedAt: snapshot.capturedAt,
  })), NOW);

  assert.equal(result.snapshotsPersisted, 2);
  assert.equal(rows.length, 2);
  assert.equal(median.state, "healthy");
  assert.equal(median.median, "1605");
});

function source(anchorSlug: string): RateCandidate {
  return {
    anchorSlug,
    corridor: { slug: "usdc-us-ngn-ng", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "NGN", countryTo: "NG" },
    request: { sellAsset: USDC, buyAsset: NGN, sellAmount: "1", context: "sep31" },
  };
}
