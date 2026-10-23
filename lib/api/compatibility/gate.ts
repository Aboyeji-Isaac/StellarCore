import { compareFixtureAgainstResponse } from "@/lib/api/compatibility/comparator";
import { executeEndpointScenario } from "@/lib/api/compatibility/harness";
import {
  DEFAULT_CONTRACT_VERSION,
  loadAllFixtures,
  loadContractManifest,
  verifyManifestIntegrity,
} from "@/lib/api/compatibility/manifest";
import type {
  CompatibilityAuditSummary,
  FixtureComparisonResult,
} from "@/lib/api/compatibility/types";

export type AuditOptions = Readonly<{
  baseDir?: string;
  contractVersion?: string;
}>;

export async function runCompatibilityAudit(
  options: AuditOptions = {},
): Promise<CompatibilityAuditSummary> {
  const baseDir = options.baseDir ?? process.cwd();
  const contractVersion = options.contractVersion ?? DEFAULT_CONTRACT_VERSION;

  const manifestCheck = verifyManifestIntegrity(baseDir, contractVersion);
  if (!manifestCheck.ok) {
    const errorResult: FixtureComparisonResult = Object.freeze({
      fixtureName: "manifest.integrity",
      domain: "anchors",
      endpoint: "CONTRACT_MANIFEST",
      expectedStatus: 200,
      actualStatus: 500,
      ok: false,
      breakingIssues: Object.freeze(
        manifestCheck.issues.map((msg) =>
          Object.freeze({
            path: "manifest",
            severity: "breaking" as const,
            message: msg,
          }),
        ),
      ),
      additiveChanges: Object.freeze([]),
    });

    return Object.freeze({
      ok: false,
      contractVersion,
      totalFixtures: 0,
      passedFixtures: 0,
      breakingCount: manifestCheck.issues.length,
      additiveCount: 0,
      results: Object.freeze([errorResult]),
    });
  }

  const manifest = loadContractManifest(baseDir, contractVersion);
  const fixtures = loadAllFixtures(baseDir, contractVersion);

  const results: FixtureComparisonResult[] = [];
  let breakingCount = 0;
  let additiveCount = 0;
  let passedFixtures = 0;

  for (const fixture of fixtures) {
    const execution = await executeEndpointScenario(fixture.name);
    const comparison = compareFixtureAgainstResponse(
      fixture,
      execution.status,
      execution.body,
    );

    results.push(comparison);
    if (comparison.ok) {
      passedFixtures += 1;
    } else {
      breakingCount += comparison.breakingIssues.length;
    }
    additiveCount += comparison.additiveChanges.length;
  }

  return Object.freeze({
    ok: breakingCount === 0,
    contractVersion: manifest.contractVersion,
    totalFixtures: fixtures.length,
    passedFixtures,
    breakingCount,
    additiveCount,
    results: Object.freeze(results),
  });
}
