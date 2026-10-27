import assert from "node:assert/strict";
import test from "node:test";

import { serializeAnchorDetail, serializeAnchors } from "@/lib/api/anchors";
import { loadAllFixtures } from "@/lib/api/compatibility/manifest";
import {
  validateAnchorsPayload,
  validateCorridorsPayload,
  validateEvidenceSchema,
  validateRatesPayload,
  validateReputationPayload,
} from "@/lib/api/compatibility/schemaValidator";
import { serializeCorridorDetail, serializeCorridors } from "@/lib/api/corridors";
import { serializeRates } from "@/lib/api/rates";
import { serializeReputation, serializeReputationList } from "@/lib/api/reputation";

test("all 31 checked-in canonical fixtures strictly pass evidence schema contracts", () => {
  const fixtures = loadAllFixtures();
  assert.equal(fixtures.length, 31);

  for (const fixture of fixtures) {
    const isDetail = fixture.endpoint.includes(":slug");
    const result = validateEvidenceSchema(
      fixture.domain,
      fixture.expectedStatus,
      fixture.body,
      isDetail,
    );

    assert.equal(
      result.ok,
      true,
      `Fixture '${fixture.name}' failed schema validation:\n${result.issues.join("\n")}`,
    );
  }
});

test("anchors schema checks required public fields explicitly and rejects missing fields", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "anchors.list.success")!;

  // Missing count
  const withoutCount = JSON.parse(JSON.stringify(listFixture.body));
  delete withoutCount.count;
  assert.equal(validateAnchorsPayload(withoutCount, false).ok, false);

  // Missing slug in summary
  const withoutSlug = JSON.parse(JSON.stringify(listFixture.body));
  delete withoutSlug.anchors[0].slug;
  const slugResult = validateAnchorsPayload(withoutSlug, false);
  assert.equal(slugResult.ok, false);
  assert.equal(slugResult.issues.some((i) => i.includes("slug")), true);

  // Detail missing corridors
  const detailFixture = fixtures.find((f) => f.name === "anchors.detail.success")!;
  const withoutCorridors = JSON.parse(JSON.stringify(detailFixture.body));
  delete withoutCorridors.anchor.corridors;
  assert.equal(validateAnchorsPayload(withoutCorridors, true).ok, false);
});

test("corridors schema checks required public fields explicitly", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "corridors.list.success")!;

  // Missing sourceAsset
  const missingSource = JSON.parse(JSON.stringify(listFixture.body));
  delete missingSource.corridors[0].sourceAsset;
  const result = validateCorridorsPayload(missingSource, false);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.includes("sourceAsset")), true);

  // Detail missing anchors array
  const detailFixture = fixtures.find((f) => f.name === "corridors.detail.success")!;
  const missingAnchors = JSON.parse(JSON.stringify(detailFixture.body));
  delete missingAnchors.corridor.anchors;
  assert.equal(validateCorridorsPayload(missingAnchors, true).ok, false);
});

test("rates schema enforces required fields and conditional semantics for medianRate", () => {
  const fixtures = loadAllFixtures();
  const healthyFixture = fixtures.find((f) => f.name === "rates.healthy.success")!;
  const insufficientFixture = fixtures.find((f) => f.name === "rates.insufficient.success")!;

  // Healthy must have string medianRate
  assert.equal(validateRatesPayload(healthyFixture.body).ok, true);
  const healthyNullMedian = JSON.parse(JSON.stringify(healthyFixture.body));
  healthyNullMedian.medianRate = null;
  const healthyResult = validateRatesPayload(healthyNullMedian);
  assert.equal(healthyResult.ok, false);
  assert.equal(healthyResult.issues.some((i) => i.includes("medianRate")), true);

  // Insufficient must have null medianRate
  assert.equal(validateRatesPayload(insufficientFixture.body).ok, true);
  const insufficientNonNullMedian = JSON.parse(JSON.stringify(insufficientFixture.body));
  insufficientNonNullMedian.medianRate = "5.50";
  const insufficientResult = validateRatesPayload(insufficientNonNullMedian);
  assert.equal(insufficientResult.ok, false);
  assert.equal(insufficientResult.issues.some((i) => i.includes("medianRate")), true);
});

test("optional fields obey documented semantics on rate observations", () => {
  const fixtures = loadAllFixtures();
  const healthyFixture = fixtures.find((f) => f.name === "rates.healthy.success")!;

  // An observation eligible for median must NOT have an exclusionReason
  const mutatedHealthy = JSON.parse(JSON.stringify(healthyFixture.body));
  mutatedHealthy.observations[0].eligibleForMedian = true;
  mutatedHealthy.observations[0].exclusionReason = "stale";
  const result = validateRatesPayload(mutatedHealthy);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((i) => i.includes("exclusionReason")), true);
});

test("reputation schema covers optional fields and nullability according to documented state semantics", () => {
  const fixtures = loadAllFixtures();
  const establishedFixture = fixtures.find((f) => f.name === "reputation.detail.established_200")!;
  const insufficientFixture = fixtures.find((f) => f.name === "reputation.detail.insufficient_200")!;
  const notEvaluatedFixture = fixtures.find((f) => f.name === "reputation.detail.not_evaluated_200")!;

  // Established requires non-null score, band, evidence, metrics, computedAt
  assert.equal(validateReputationPayload(establishedFixture.body, true).ok, true);
  const establishedMissingScore = JSON.parse(JSON.stringify(establishedFixture.body));
  establishedMissingScore.reputation.score = null;
  assert.equal(validateReputationPayload(establishedMissingScore, true).ok, false);

  // Insufficient requires null score and band
  assert.equal(validateReputationPayload(insufficientFixture.body, true).ok, true);
  const insufficientFabricatedScore = JSON.parse(JSON.stringify(insufficientFixture.body));
  insufficientFabricatedScore.reputation.score = 75;
  assert.equal(validateReputationPayload(insufficientFabricatedScore, true).ok, false);

  // Not evaluated requires null for all derived evidence fields
  assert.equal(validateReputationPayload(notEvaluatedFixture.body, true).ok, true);
  const notEvalFabricatedEvidence = JSON.parse(JSON.stringify(notEvaluatedFixture.body));
  notEvalFabricatedEvidence.reputation.evidence = { outcomeCount: 10 };
  assert.equal(validateReputationPayload(notEvalFabricatedEvidence, true).ok, false);
});

test("internal-only database fields are rejected from public payloads across all four domains", () => {
  const fixtures = loadAllFixtures();
  const banned = ["id", "tomlUrl", "lastSyncOrder", "createdAt", "updatedAt", "anchorId", "corridorId", "_count"];

  const listAnchorFixture = fixtures.find((f) => f.name === "anchors.list.success")!;
  for (const field of banned) {
    const leaked = JSON.parse(JSON.stringify(listAnchorFixture.body));
    leaked.anchors[0][field] = "internal-leak-123";
    const res = validateAnchorsPayload(leaked, false);
    assert.equal(res.ok, false, `Failed to reject internal field '${field}' on anchors`);
    assert.equal(res.issues.some((i) => i.includes(field)), true);
  }

  const corridorFixture = fixtures.find((f) => f.name === "corridors.list.success")!;
  for (const field of ["id", "assetCodeFrom", "countryFrom"]) {
    const leaked = JSON.parse(JSON.stringify(corridorFixture.body));
    leaked.corridors[0][field] = "internal-leak-123";
    const res = validateCorridorsPayload(leaked, false);
    assert.equal(res.ok, false, `Failed to reject internal field '${field}' on corridors`);
  }

  const ratesFixture = fixtures.find((f) => f.name === "rates.healthy.success")!;
  for (const field of ["id", "rawRate", "rawTimestamp"]) {
    const leaked = JSON.parse(JSON.stringify(ratesFixture.body));
    leaked.observations[0][field] = "internal-leak-123";
    const res = validateRatesPayload(leaked);
    assert.equal(res.ok, false, `Failed to reject internal field '${field}' on rates`);
  }

  const repFixture = fixtures.find((f) => f.name === "reputation.list.success")!;
  for (const field of ["id", "compositeScore", "sampleSize"]) {
    const leaked = JSON.parse(JSON.stringify(repFixture.body));
    leaked.reputation[0][field] = "internal-leak-123";
    const res = validateReputationPayload(leaked, false);
    assert.equal(res.ok, false, `Failed to reject internal field '${field}' on reputation`);
  }
});

test("public API serializers never leak internal fields when provided database records with extra columns", () => {
  // Anchors serializer strips internal DB columns
  const rawAnchors = [
    {
      id: "uuid-1234",
      slug: "zeam",
      name: "Zeam",
      homeDomain: "zeam.example",
      status: "LIVE" as const,
      seps: [1, 24],
      corridorCount: 1,
      tomlUrl: "https://zeam.example/.well-known/stellar.toml",
      lastSyncOrder: 42n,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { corridors: 1 },
    },
  ];
  const serializedAnchors = serializeAnchors(rawAnchors);
  assert.equal(validateAnchorsPayload(serializedAnchors, false).ok, true);
  assert.equal("id" in serializedAnchors.anchors[0]!, false);
  assert.equal("tomlUrl" in serializedAnchors.anchors[0]!, false);
  assert.equal("lastSyncOrder" in serializedAnchors.anchors[0]!, false);
  assert.equal("_count" in serializedAnchors.anchors[0]!, false);

  // Anchor detail serializer strips internal DB columns
  const rawAnchorDetail = {
    id: "uuid-1234",
    slug: "zeam",
    name: "Zeam",
    homeDomain: "zeam.example",
    status: "LIVE" as const,
    seps: [1, 24],
    corridors: [
      {
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
        anchorId: "uuid-1234",
        corridorId: "uuid-5678",
      },
    ],
  };
  const serializedDetail = serializeAnchorDetail(rawAnchorDetail);
  assert.equal(validateAnchorsPayload({ anchor: serializedDetail }, true).ok, true);
  assert.equal("anchorId" in serializedDetail.corridors[0]!, false);
  assert.equal("corridorId" in serializedDetail.corridors[0]!, false);

  // Corridors serializer strips internal columns
  const rawCorridors = [
    {
      id: "corridor-uuid-999",
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
      anchorCount: 2,
    },
  ];
  const serializedCorridors = serializeCorridors(rawCorridors);
  assert.equal(validateCorridorsPayload(serializedCorridors, false).ok, true);
  assert.equal("id" in serializedCorridors.corridors[0]!, false);
  assert.equal("assetCodeFrom" in serializedCorridors.corridors[0]!, false);

  // Corridor detail serializer strips internal columns
  const rawCorridorDetail = {
    id: "corridor-uuid-999",
    slug: "usdc-us-brl-br",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchorCount: 1,
    anchors: [
      {
        id: "anchor-uuid-1",
        slug: "zeam",
        name: "Zeam",
        homeDomain: "zeam.example",
        status: "LIVE" as const,
        seps: [1, 24],
        isTransferCapable: true,
      },
    ],
  };
  const serializedCorridorDetail = serializeCorridorDetail(rawCorridorDetail);
  assert.equal(validateCorridorsPayload({ corridor: serializedCorridorDetail }, true).ok, true);
  assert.equal("id" in serializedCorridorDetail.anchors[0]!, false);

  // Rates serializer strips internal columns
  const rawRatesRead = {
    ok: true as const,
    corridor: {
      id: "db-corridor-id",
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    },
    evaluatedAt: "2026-08-28T12:00:00.000Z",
    state: "healthy" as const,
    median: "5.25",
    totalIndependentSources: 2,
    freshSourceCount: 2,
    observations: [
      {
        snapshotId: "db-rate-snapshot-id",
        anchorSlug: "zeam",
        anchorName: "Zeam",
        rate: "5.25",
        sourceAmount: "100",
        destinationAmount: "525",
        fee: "0",
        capturedAt: "2026-08-28T11:58:00.000Z",
        freshnessState: "fresh" as const,
        ageMs: 1_000,
        included: true,
      },
    ],
    exclusions: [],
  };
  const serializedRates = serializeRates(rawRatesRead);
  assert.equal(validateRatesPayload(serializedRates).ok, true);
  assert.equal("id" in serializedRates.corridor, false);
  assert.equal("id" in serializedRates.observations[0]!, false);
  assert.equal("snapshotId" in serializedRates.observations[0]!, false);

  // Reputation serializer strips internal columns
  const rawReputation = [
    {
      id: "anchor-id-777",
      slug: "zeam",
      name: "Zeam",
      reputationScore: {
        id: "score-id-888",
        anchorId: "anchor-id-777",
        compositeScore: 92,
        scoreBand: "GREEN" as const,
        fillRate7d: 0.99,
        fillRate30d: 0.98,
        fillRate90d: 0.97,
        settleP50Ms: 1200,
        settleP95Ms: 3400,
        slippageP50: 0.001,
        slippageP95: 0.005,
        sampleSize: 100,
        state: "OK" as const,
        computedAt: new Date("2026-08-28T12:00:00.000Z"),
      },
    },
  ];
  const serializedRepList = serializeReputationList(rawReputation);
  assert.equal(validateReputationPayload(serializedRepList, false).ok, true);
  assert.equal("id" in serializedRepList.reputation[0]!, false);
  assert.equal("compositeScore" in serializedRepList.reputation[0]!, false);
  assert.equal("sampleSize" in serializedRepList.reputation[0]!, false);

  const serializedRepSingle = serializeReputation(rawReputation[0]!);
  assert.equal(validateReputationPayload({ reputation: serializedRepSingle }, true).ok, true);
  assert.equal("id" in serializedRepSingle, false);
  assert.equal("compositeScore" in serializedRepSingle, false);
});
