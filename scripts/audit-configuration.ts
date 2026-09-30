/**
 * Offline audit of every repository-controlled registry: the anchor, corridor,
 * membership, and reviewed rate-source relationships, plus the reviewed
 * production database target identity.
 *
 * Pure and deterministic. It requires no database, no network, and no
 * environment secrets, so a pull request that changes a registry — including a
 * planned production database replacement — is validated before it can reach a
 * privileged workflow.
 */
type AuditIssue = Readonly<Record<string, unknown>>;

type AuditEnvelope = Readonly<{
  ok: boolean;
  issueCount: number;
  issues: readonly AuditIssue[];
}>;

async function main(): Promise<void> {
  try {
    const { auditCurrentStellarCoreConfiguration } = await import(
      "@/lib/config/currentStellarCoreConfiguration"
    );
    const { auditCurrentProductionDatabaseIdentityRegistry } = await import(
      "@/lib/config/currentProductionDatabaseIdentity"
    );

    const result = auditCurrentStellarCoreConfiguration();
    const identity = auditCurrentProductionDatabaseIdentityRegistry();

    const configuration: AuditEnvelope = {
      ok: result.ok,
      issueCount: result.issues.length,
      issues: result.issues,
    };
    const productionDatabaseIdentity: AuditEnvelope = {
      ok: identity.ok,
      issueCount: identity.issues.length,
      issues: identity.issues,
    };

    process.stdout.write(`${JSON.stringify({
      ok: configuration.ok && productionDatabaseIdentity.ok,
      issueCount: configuration.issueCount + productionDatabaseIdentity.issueCount,
      issues: configuration.issues,
      productionDatabaseIdentity,
    })}\n`);

    if (!configuration.ok || !productionDatabaseIdentity.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      issueCount: 1,
      issues: [{
        code: "CONFIGURATION_LOAD_FAILURE",
        registry: "configuration",
      }],
      productionDatabaseIdentity: {
        ok: false,
        issueCount: 1,
        issues: [{ code: "PRODUCTION_DATABASE_IDENTITY_LOAD_FAILURE" }],
      },
    })}\n`);
    process.exitCode = 1;
  }
}

void main();
