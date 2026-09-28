import assert from "node:assert/strict";
import test from "node:test";

import {
  getReviewedAuthorityDisplayName,
  getReviewedCandidateConfiguration,
} from "@/lib/rates/reviewedCandidateConfiguration";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

const CORRIDOR = "usdc-us-brl-br";

test("returns zero counts when no reviewed candidate matches the corridor", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [source("other", "other-corridor")]), {
    candidateCount: 0,
    uniqueAnchorCount: 0,
    uniqueAuthorityCount: 0,
  });
});

test("counts one matching candidate, anchor, and authority", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [source("one")]), {
    candidateCount: 1,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
});

test("counts matching candidate entries separately from distinct configured anchors", () => {
  assert.deepEqual(getReviewedCandidateConfiguration(CORRIDOR, [
    source("one"),
    source("one"),
    source("two", CORRIDOR, "auth-0002"),
    source("ignored", "other-corridor"),
  ]), {
    candidateCount: 3,
    uniqueAnchorCount: 2,
    uniqueAuthorityCount: 2,
  });
});

test("differently named anchors under one reviewed authority count once", () => {
  const configuration = getReviewedCandidateConfiguration(CORRIDOR, [
    source("zeam"),
    source("zeam-partner"),
  ]);

  assert.equal(configuration.uniqueAnchorCount, 2);
  assert.equal(configuration.uniqueAuthorityCount, 1);
});

test("resolves reviewed display labels without changing authority identity", () => {
  assert.equal(getReviewedAuthorityDisplayName("auth-0001"), "Zeam");
  assert.equal(getReviewedAuthorityDisplayName("auth-9999"), null);
  assert.equal(getReviewedAuthorityDisplayName(null), null);
  assert.equal(getReviewedAuthorityDisplayName("zeam"), null);
  assert.equal(getReviewedAuthorityDisplayName("auth-0001", [
    { authorityId: "auth-0001", displayName: "Renamed Label", configurationVersion: 7 },
  ]), "Renamed Label");
});

test("returns immutable deterministic configuration facts", () => {
  const configuration = getReviewedCandidateConfiguration(CORRIDOR, [source("one"), source("one")]);

  assert.deepEqual(configuration, {
    candidateCount: 2,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.throws(() => {
    (configuration as { candidateCount: number }).candidateCount = 0;
  }, TypeError);
});

function source(
  anchorSlug: string,
  corridorSlug = CORRIDOR,
  authorityId = "auth-0001",
): ReviewedLiveRateSource {
  return Object.freeze({
    anchorSlug,
    corridorSlug,
    authorityId,
    sellAsset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    buyAsset: "iso4217:BRL",
    sellAmount: "100",
    context: "sep31",
  });
}
