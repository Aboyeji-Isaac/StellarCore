/**
 * Next.js instrumentation hook. Telemetry starts only in the Node.js runtime
 * and only when OTEL_* export variables are configured; otherwise every
 * instrument is a no-op. See docs/observability.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTelemetryFromEnvironment } = await import("./lib/telemetry/node");
  startTelemetryFromEnvironment();
}
