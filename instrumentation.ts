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
  assertRuntimeConfig();
}
