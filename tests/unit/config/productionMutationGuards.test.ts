import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStellarCoreConfiguration,
  auditStellarCoreConfiguration,
  StellarCoreConfigurationAuditError,
  type StellarCoreConfigurationInput,
} from "@/lib/config/stellarCoreConfiguration";
import {
  snapshotReviewedLiveRates,
  type SnapshotReviewedLiveRatesDependencies,
} from "@/lib/rates/snapshotRun";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const ANCHOR = Object.freeze({
  slug: "anchor-a",
  name: "Anchor A",
  homeDomain: "anchor-a.example.com",
}) satisfies AnchorRegistryEntry;

const CORRIDOR = Object.freeze({
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
}) satisfies CorridorRegistryEntry;

const MAPPING = Object.freeze({
  anchorSlug: "anchor-a",
  corridorSlugs: ["usdc-us-brl-br"],
}) satisfies AnchorCorridorRegistryEntry;

function source(
  overrides: Partial<ReviewedLiveRateSource> = {},
): ReviewedLiveRateSource {
  return Object.freeze({
    anchorSlug: "anchor-a",
    corridorSlug: "usdc-us-brl-br",
    sellAsset: `stellar:USDC:${ISSUER}` as const,
    buyAsset: "iso4217:BRL" as const,
    sellAmount: "100",
    countryCode: "BR",
    context: "sep31" as const,
    ...overrides,
  });
}

function configuration(
  overrides: Partial<StellarCoreConfigurationInput> = {},
): StellarCoreConfigurationInput {
  return Object.freeze({
    anchors: [ANCHOR],
    corridors: [CORRIDOR],
    anchorCorridorMappings: [MAPPING],
    reviewedLiveRateSources: [source()],
    ...overrides,
  });
}

test("a production mutation path fails closed when reviewed configuration evidence is missing", async () => {
  let builds = 0;
  let executions = 0;
  const dependencies: SnapshotReviewedLiveRatesDependencies = {
    assertConfiguration: () =>
      assertStellarCoreConfiguration(configuration({
        reviewedLiveRateSources: [source({ anchorSlug: "ghost-anchor" })],
        anchorCorridorMappings: [],
      })),
    buildCandidates: async () => {
      builds += 1;
      return [];
    },
    executeCandidates: async () => {
      executions += 1;
      return runSummary();
    },
  };

  await assert.rejects(
    snapshotReviewedLiveRates(dependencies),
    (error) => {
      assert.ok(error instanceof StellarCoreConfigurationAuditError);
      assert.ok(error.issues.some(({ code }) => code === "SOURCE_ANCHOR_NOT_FOUND"));
      return true;
    },
    "missing review evidence must be named by the guard",
  );
  assert.equal(builds, 0,
    "missing review evidence must not reach candidate preparation");
  assert.equal(executions, 0,
    "missing review evidence must not reach the mutation boundary");
});

test("malformed reviewed evidence blocks the mutation path without secrets", () => {
  for (const [name, input] of [
    ["unregistered anchor", configuration({
      reviewedLiveRateSources: [source({ anchorSlug: "ghost-anchor" })],
    })],
    ["unregistered corridor", configuration({
      reviewedLiveRateSources: [source({ corridorSlug: "usdc-us-eur-de" })],
    })],
    ["membership not configured", configuration({
      anchorCorridorMappings: [],
    })],
    ["corrupted asset form", configuration({
      reviewedLiveRateSources: [source({ buyAsset: "iso4217:brl-bad" as never })],
    })],
    ["stale duplicate identity", configuration({
      reviewedLiveRateSources: [source(), source()],
    })],
  ] as const satisfies readonly (readonly [string, StellarCoreConfigurationInput])[]) {
    const result = auditStellarCoreConfiguration(input);
    assert.equal(result.ok, false, `${name} must fail`);
    assert.ok(result.issues.length > 0, `${name} must report its failure category`);

    assert.throws(
      () => assertStellarCoreConfiguration(input),
      (error) => {
        assert.ok(error instanceof StellarCoreConfigurationAuditError);
        assert.equal(error.code, "INVALID_STELLARCORE_CONFIGURATION");
        assert.ok(error.issues.length > 0);
        assert.ok(!JSON.stringify(error.issues).includes(ISSUER),
          "diagnostics never embed reviewed secret material");
        return true;
      },
      name,
    );
  }
});

test("diagnostics name the required prerequisite without exposing configuration text", () => {
  const result = auditStellarCoreConfiguration(configuration({
    reviewedLiveRateSources: [source({ sellAmount: "not-a-number" })],
    corridors: [],
    anchorCorridorMappings: [],
  }));

  const codes = new Set(result.issues.map(({ code }) => code));
  assert.ok(codes.has("SOURCE_CORRIDOR_NOT_FOUND"),
    "the missing corridor prerequisite is named");
  assert.ok(codes.has("SOURCE_SELL_AMOUNT_INVALID"),
    "the malformed prerequisite field is named");
  assert.ok(!JSON.stringify(result.issues).includes(ISSUER),
    "reviewed asset identifiers stay out of diagnostics");
});

test("valid reviewed configuration continues through the existing safeguards", async () => {
  let builds = 0;
  const result = await snapshotReviewedLiveRates({
    assertConfiguration: () =>
      assertStellarCoreConfiguration(configuration()),
    buildCandidates: async () => {
      builds += 1;
      return [];
    },
    executeCandidates: async () => runSummary(),
  });

  const audit = auditStellarCoreConfiguration(configuration());
  assert.equal(audit.ok, true);
  assert.equal(audit.issues.length, 0);
  assert.equal(builds, 1);
  assert.deepEqual(result, runSummary());
});

test("every absent-prerequisite issue carries registry context without entry payloads", () => {
  const result = auditStellarCoreConfiguration(
    configuration({ reviewedLiveRateSources: [source({ anchorSlug: "ghost" })] }),
  );

  const issue = result.issues.find(({ code }) => code === "SOURCE_ANCHOR_NOT_FOUND");
  assert.ok(issue, "absent anchor review evidence is named as the prerequisite");
  assert.equal(issue!.registry, "reviewedLiveRateSources");
  assert.ok(!JSON.stringify(issue).includes(ISSUER));
});

function runSummary(): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 0,
    totalAttempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 0,
    snapshots: Object.freeze([]),
    failures: Object.freeze([]),
    skippedSources: Object.freeze([]),
  });
}
