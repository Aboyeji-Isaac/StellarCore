import assert from "node:assert/strict";
import test from "node:test";

import { getReviewedCandidateConfiguration } from "@/lib/rates/reviewedCandidateConfiguration";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

const CORRIDOR = "usdc-us-brl-br";

test("returns zero counts when no reviewed candidate matches the corridor", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [source("other", "other-corridor")]), {
    candidateCount: 0,
    uniqueAnchorCount: 0,
  });
});

test("counts one matching candidate and anchor", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [source("one")]), {
    candidateCount: 1,
    uniqueAnchorCount: 1,
  });
});

test("counts matching candidate entries separately from distinct configured anchors", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [
    source("one"),
    source("one"),
    source("two"),
    source("ignored", "other-corridor"),
  ]), {
    candidateCount: 3,
    uniqueAnchorCount: 2,
  });
});

test("returns immutable deterministic configuration facts", () => {
  const configuration = getReviewedCandidateConfiguration(CORRIDOR, [source("one"), source("one")]);

  assert.deepEqual(configuration, { candidateCount: 2, uniqueAnchorCount: 1 });
  assert.equal(Object.isFrozen(configuration), true);
  assert.throws(() => {
    (configuration as { candidateCount: number }).candidateCount = 0;
  }, TypeError);
});

function source(anchorSlug: string, corridorSlug = CORRIDOR): ReviewedLiveRateSource {
  return Object.freeze({
    anchorSlug,
    corridorSlug,
    sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    buyAsset: "iso4217:BRL",
    sellAmount: "100",
    context: "sep31",
  });
}
