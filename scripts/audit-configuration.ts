/**
 * Deployment-time runtime configuration fingerprint audit.
 *
 * Emits the canonical, secret-safe fingerprint over approved non-secret
 * runtime configuration and policy identifiers, and compares it against the
 * fingerprint recorded at build/release time. A mismatch indicates
 * unexpected configuration drift between the reviewed revision and the
 * effective runtime configuration.
 *
 * Mismatch policy:
 *   - "fail" (default): exit non-zero so the deployment is blocked.
 *   - "warn": emit the drift report but exit zero.
 *   - "off": skip drift detection entirely.
 *
 * Intentional configuration updates must go through review: update the
 * approved configuration, regenerate the expected fingerprint during
 * build/release, and roll out the new fingerprint together with the
 * deployment revision. See docs/config-fingerprint.md.
 */
async function main(): Promise<void> {
  try {
    const { auditCurrentStellarCoreConfiguration } = await import(
      "@/lib/config/currentStellarCoreConfiguration"
    );
    const result = auditCurrentStellarCoreConfiguration();

    const { computeRuntimeConfigFingerprint } = await import(
      "@/lib/config/runtimeConfigFingerprint"
    );
    const fingerprint = computeRuntimeConfigFingerprint();

    const driftPolicy =
      (process.env.CONFIG_FINGERPRINT_DRIFT_POLICY ?? "fail").toLowerCase();

    const driftDetected =
      driftPolicy !== "off" &&
      fingerprint.expected !== undefined &&
      fingerprint.expected !== fingerprint.actual;

    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      issueCount: result.issues.length,
      issues: result.issues,
      fingerprint: {
        algorithm: fingerprint.algorithm,
        actual: fingerprint.actual,
        expected: fingerprint.expected ?? null,
        revision: fingerprint.revision ?? null,
        driftDetected,
        driftPolicy,
      },
    })}\n`);

    if (!result.ok) process.exitCode = 1;
    if (driftDetected && driftPolicy === "fail") process.exitCode = 1;
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
