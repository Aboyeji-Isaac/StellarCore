/**
 * Startup validation boundary (#175).
 *
 * Next.js invokes register() once when the server starts. Production-critical
 * runtime configuration is validated here — the earliest safe initialization
 * boundary — so invalid or missing settings fail deterministically before
 * any request is served, instead of surfacing later inside unrelated
 * request paths.
 *
 * The hook is a no-op outside the Node.js server runtimes: it never runs
 * during `next build` (the release workflow builds without CRON_SECRET) and
 * never in the Edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const phase = process.env.NEXT_PHASE;
  if (phase !== "phase-production-server" && phase !== "phase-development-server") return;

  const { assertRuntimeConfig } = await import("@/lib/config/runtimeConfig");
  const config = assertRuntimeConfig();

  const {
    resolveDeploymentRevision,
    resolveRuntimeConfigFingerprintPolicy,
    verifyRuntimeConfigFingerprint,
  } = await import("@/lib/config/runtimeConfigFingerprint");

  const diagnostics = verifyRuntimeConfigFingerprint(config, {
    expectedFingerprint: process.env.STELLARCORE_CONFIG_FINGERPRINT,
    revision: resolveDeploymentRevision(process.env),
    policy: resolveRuntimeConfigFingerprintPolicy(config, process.env),
  });

  console.info(JSON.stringify({
    event: "runtime_config_fingerprint",
    fingerprint: diagnostics.activeFingerprint,
    expectedFingerprint: diagnostics.expectedFingerprint,
    revision: diagnostics.revision,
    policy: diagnostics.policy,
    bound: diagnostics.bound,
    driftDetected: diagnostics.driftDetected,
    degraded: diagnostics.degraded,
  }));
}
