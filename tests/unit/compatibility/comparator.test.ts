import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFixtureAgainstResponse,
  comparePayloads,
} from "@/lib/api/compatibility/comparator";
import type { CompatibilityFixture } from "@/lib/api/compatibility/types";

test("comparePayloads returns clean result for identical payloads", () => {
  const expected = { slug: "zeam", name: "Zeam", count: 3 };
  const actual = { slug: "zeam", name: "Zeam", count: 3 };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 0);
  assert.equal(diff.additiveChanges.length, 0);
});

test("comparePayloads flags missing fields as breaking", () => {
  const expected = { slug: "zeam", name: "Zeam", count: 3 };
  const actual = { slug: "zeam", name: "Zeam" };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 1);
  assert.equal(diff.breakingIssues[0]?.severity, "breaking");
  assert.equal(diff.breakingIssues[0]?.path, "count");
  assert.equal(diff.breakingIssues[0]?.message.includes("Missing required field"), true);
});

test("comparePayloads flags field renaming as missing expected field and additive new field", () => {
  const expected = { homeDomain: "zeam.example" };
  const actual = { domain: "zeam.example" };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 1);
  assert.equal(diff.breakingIssues[0]?.path, "homeDomain");
  assert.equal(diff.additiveChanges.length, 1);
  assert.equal(diff.additiveChanges[0]?.path, "domain");
});

test("comparePayloads flags type mismatch as breaking", () => {
  const expected = { count: 3 };
  const actual = { count: "3" };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 1);
  assert.equal(diff.breakingIssues[0]?.path, "count");
  assert.equal(diff.breakingIssues[0]?.message.includes("Type mismatch"), true);
});

test("comparePayloads flags nullability mismatch as breaking", () => {
  const expected = { score: 95 };
  const actual = { score: null };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 1);
  assert.equal(diff.breakingIssues[0]?.path, "score");
  assert.equal(diff.breakingIssues[0]?.message.includes("null"), true);

  // Expected null but got non-null
  const expectedNull = { score: null };
  const actualNonNull = { score: 95 };
  const diff2 = comparePayloads(expectedNull, actualNonNull);
  assert.equal(diff2.breakingIssues.length, 1);
  assert.equal(diff2.breakingIssues[0]?.path, "score");
});

test("comparePayloads permits compatible additive fields without breaking", () => {
  const expected = { slug: "zeam", name: "Zeam" };
  const actual = { slug: "zeam", name: "Zeam", description: "Anchor service" };

  const diff = comparePayloads(expected, actual);
  assert.equal(diff.breakingIssues.length, 0);
  assert.equal(diff.additiveChanges.length, 1);
  assert.equal(diff.additiveChanges[0]?.severity, "additive");
  assert.equal(diff.additiveChanges[0]?.path, "description");
});

test("comparePayloads detects array length and ordering mismatches", () => {
  const expected = ["apple", "banana"];
  const actual = ["banana", "apple"];

  const diff = comparePayloads(expected, actual);
  // Same length, but items at index 0 and 1 don't match
  assert.equal(diff.breakingIssues.length, 2);
  assert.equal(diff.breakingIssues[0]?.path, "$[0]");
  assert.equal(diff.breakingIssues[1]?.path, "$[1]");
});

test("compareFixtureAgainstResponse flags HTTP status regressions", () => {
  const fixture: CompatibilityFixture = {
    name: "test.fixture",
    domain: "anchors",
    endpoint: "GET /api/anchors/:slug",
    method: "GET",
    expectedStatus: 404,
    description: "Not found",
    body: { error: { code: "anchor_not_found", message: "Not found" } },
  };

  const result = compareFixtureAgainstResponse(fixture, 200, fixture.body);
  assert.equal(result.ok, false);
  assert.equal(result.breakingIssues.length, 1);
  assert.equal(result.breakingIssues[0]?.path, "status");
  assert.equal(result.breakingIssues[0]?.message.includes("HTTP status code regression"), true);
});
