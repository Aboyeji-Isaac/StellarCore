import { runCompatibilityAudit } from "@/lib/api/compatibility/gate";

export async function auditCompatibilityCli(): Promise<void> {
  try {
    const result = await runCompatibilityAudit();

    const breakingChanges = result.results
      .filter((res) => !res.ok)
      .map((res) => ({
        fixtureName: res.fixtureName,
        endpoint: res.endpoint,
        expectedStatus: res.expectedStatus,
        actualStatus: res.actualStatus,
        issues: res.breakingIssues,
      }));

    const additiveChanges = result.results
      .filter((res) => res.additiveChanges.length > 0)
      .map((res) => ({
        fixtureName: res.fixtureName,
        endpoint: res.endpoint,
        additions: res.additiveChanges,
      }));

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          contractVersion: result.contractVersion,
          totalFixtures: result.totalFixtures,
          passedFixtures: result.passedFixtures,
          breakingCount: result.breakingCount,
          additiveCount: result.additiveCount,
          breakingChanges,
          additiveChanges,
        },
        null,
        2,
      )}\n`,
    );

    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void auditCompatibilityCli();
