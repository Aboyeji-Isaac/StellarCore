import assert from "node:assert/strict";
import test from "node:test";

import { compareFixtureAgainstResponse } from "@/lib/api/compatibility/comparator";
import { loadAllFixtures } from "@/lib/api/compatibility/manifest";

test("gate fails when a required top-level field is removed", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "anchors.list.success")!;

  const mutatedBody = JSON.parse(
    JSON.stringify(listFixture.body),
  ) as Record<string, unknown>;
  delete mutatedBody["count"];

  const result = compareFixtureAgainstResponse(listFixture, 200, mutatedBody);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.length, 1);
  assert.equal(result.breakingIssues[0]?.path, "count");
  assert.equal(result.breakingIssues[0]?.message.includes("Missing required field"), true);
});

test("gate fails when a nested required field is renamed", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "anchors.list.success")!;

  const mutatedBody = JSON.parse(JSON.stringify(listFixture.body));
  const firstAnchor = mutatedBody.anchors[0];
  firstAnchor.transferCapable = firstAnchor.isTransferCapable;
  delete firstAnchor.isTransferCapable;

  const result = compareFixtureAgainstResponse(listFixture, 200, mutatedBody);
  assert.equal(result.ok, false);
  const missing = result.breakingIssues.find((i) => i.path.includes("isTransferCapable"));
  assert.notEqual(missing, undefined);
  const additive = result.additiveChanges.find((i) => i.path.includes("transferCapable"));
  assert.notEqual(additive, undefined);
});

test("gate fails when a field type changes", () => {
  const fixtures = loadAllFixtures();
  const ratesFixture = fixtures.find((f) => f.name === "rates.healthy.success")!;

  const mutatedBody = JSON.parse(JSON.stringify(ratesFixture.body));
  mutatedBody.medianRate = 5.25; // number instead of string decimal

  const result = compareFixtureAgainstResponse(ratesFixture, 200, mutatedBody);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.length, 1);
  assert.equal(result.breakingIssues[0]?.path, "medianRate");
  assert.equal(result.breakingIssues[0]?.message.includes("Type mismatch"), true);
});

test("gate fails when a nullability guarantee is broken", () => {
  const fixtures = loadAllFixtures();
  const reputationFixture = fixtures.find((f) => f.name === "reputation.detail.established_200")!;

  const mutatedBody = JSON.parse(JSON.stringify(reputationFixture.body));
  mutatedBody.reputation.score = null;

  const result = compareFixtureAgainstResponse(reputationFixture, 200, mutatedBody);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.length, 1);
  assert.equal(result.breakingIssues[0]?.path, "reputation.score");
  assert.equal(result.breakingIssues[0]?.message.includes("null"), true);
});

test("gate fails when an HTTP status code regresses", () => {
  const fixtures = loadAllFixtures();
  const error400Fixture = fixtures.find((f) => f.name === "anchors.detail.error_400")!;

  const result = compareFixtureAgainstResponse(error400Fixture, 500, error400Fixture.body);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.some((i) => i.path === "status"), true);
});

test("gate fails when an error code changes unexpectedly", () => {
  const fixtures = loadAllFixtures();
  const notFoundFixture = fixtures.find((f) => f.name === "corridors.detail.error_404")!;

  const mutatedBody = {
    error: {
      code: "not_found", // regressed from "corridor_not_found"
      message: "Corridor not found.",
    },
  };

  const result = compareFixtureAgainstResponse(notFoundFixture, 404, mutatedBody);
  assert.equal(result.ok, false);
  const codeMismatch = result.breakingIssues.find((i) => i.path === "error.code");
  assert.notEqual(codeMismatch, undefined);
});

test("gate fails when array deterministic ordering is altered", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "corridors.list.success")!;

  const mutatedBody = JSON.parse(JSON.stringify(listFixture.body));
  mutatedBody.corridors.reverse();

  const result = compareFixtureAgainstResponse(listFixture, 200, mutatedBody);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.length > 0, true);
});

test("gate permits non-breaking additive fields under the documented additive policy", () => {
  const fixtures = loadAllFixtures();
  const listFixture = fixtures.find((f) => f.name === "anchors.list.success")!;

  const mutatedBody = JSON.parse(JSON.stringify(listFixture.body));
  mutatedBody.anchors[0].custodyType = "non_custodial"; // new additive optional property

  const result = compareFixtureAgainstResponse(listFixture, 200, mutatedBody);
  assert.equal(result.ok, true); // Still ok because no breaking issues!
  assert.equal(result.breakingIssues.length, 0);
  assert.equal(result.additiveChanges.length, 1);
  assert.equal(result.additiveChanges[0]?.path, "anchors[0].custodyType");
  assert.equal(result.additiveChanges[0]?.severity, "additive");
});
