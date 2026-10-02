import assert from "node:assert/strict";
import test from "node:test";

import { runCompatibilityAudit } from "@/lib/api/compatibility/gate";
import {
  loadAllFixtures,
  loadContractManifest,
  verifyManifestIntegrity,
} from "@/lib/api/compatibility/manifest";

test("all four API domains are covered by canonical fixtures", () => {
  const fixtures = loadAllFixtures();
  assert.equal(fixtures.length, 31);

  const domains = new Set(fixtures.map((f) => f.domain));
  assert.deepEqual(Array.from(domains).sort(), [
    "anchors",
    "corridors",
    "rates",
    "reputation",
  ]);

  const anchorsFixtures = fixtures.filter((f) => f.domain === "anchors");
  const corridorsFixtures = fixtures.filter((f) => f.domain === "corridors");
  const ratesFixtures = fixtures.filter((f) => f.domain === "rates");
  const reputationFixtures = fixtures.filter((f) => f.domain === "reputation");

  assert.equal(anchorsFixtures.length, 7);
  assert.equal(corridorsFixtures.length, 8);
  assert.equal(ratesFixtures.length, 7);
  assert.equal(reputationFixtures.length, 9);
});

test("all fixtures define valid HTTP contracts with status codes and non-empty bodies", () => {
  const fixtures = loadAllFixtures();
  const validStatuses = new Set([200, 400, 404, 500]);

  for (const fixture of fixtures) {
    assert.equal(typeof fixture.name, "string");
    assert.equal(fixture.name.length > 0, true);
    assert.equal(fixture.method, "GET");
    assert.equal(validStatuses.has(fixture.expectedStatus), true);
    assert.equal(typeof fixture.description, "string");
    assert.equal(fixture.description.length > 0, true);
    assert.notEqual(fixture.body, null);
    assert.notEqual(fixture.body, undefined);
  }
});

test("manifest integrity verification passes for checked-in fixtures", () => {
  const check = verifyManifestIntegrity();
  assert.equal(check.ok, true, `Manifest verification failed: ${check.issues.join(", ")}`);
  assert.equal(check.issues.length, 0);

  const manifest = loadContractManifest();
  assert.equal(manifest.contractVersion, "v1");
  assert.equal(manifest.totalFixtures, 31);
  assert.equal(manifest.fixtures.length, 31);
});

test("full compatibility audit against current serializers passes with zero breaking changes", async () => {
  const audit = await runCompatibilityAudit();

  assert.equal(audit.ok, true);
  assert.equal(audit.contractVersion, "v1");
  assert.equal(audit.totalFixtures, 31);
  assert.equal(audit.passedFixtures, 31);
  assert.equal(audit.breakingCount, 0);
  assert.equal(audit.additiveCount, 0);
});
