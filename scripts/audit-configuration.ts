async function main(): Promise<void> {
  try {
    const { auditCurrentStellarCoreConfiguration } = await import(
      "@/lib/config/currentStellarCoreConfiguration"
    );
    const result = auditCurrentStellarCoreConfiguration();
    const { assertRuntimeConfig } = await import("@/lib/config/runtimeConfig");
    const {
      resolveDeploymentRevision,
      resolveRuntimeConfigFingerprintPolicy,
      verifyRuntimeConfigFingerprint,
    } = await import("@/lib/config/runtimeConfigFingerprint");

    const config = assertRuntimeConfig();
    const fingerprint = verifyRuntimeConfigFingerprint(config, {
      expectedFingerprint: process.env.STELLARCORE_CONFIG_FINGERPRINT,
      revision: resolveDeploymentRevision(process.env),
      policy: resolveRuntimeConfigFingerprintPolicy(config, process.env),
    });

    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      issueCount: result.issues.length,
      issues: result.issues,
      runtimeConfigFingerprint: fingerprint,
    })}\n`);

    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      issueCount: 1,
      issues: [{
        code: "CONFIGURATION_LOAD_FAILURE",
        registry: "configuration",
      }],
    })}\n`);
    process.exitCode = 1;
  }
}

void main();
