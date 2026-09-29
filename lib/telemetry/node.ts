import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

import { startTelemetrySdk } from "@/lib/telemetry/sdk";

type Environment = Readonly<Record<string, string | undefined>>;

export type TelemetryStartResult = Readonly<{
  enabled: boolean;
  traces: boolean;
  metrics: boolean;
  reason?: "DISABLED" | "NOT_CONFIGURED" | "INVALID_ENDPOINT" | "START_FAILURE";
}>;

export const EXPORT_TIMEOUT_MS = 5_000;
export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;

const state = globalThis as unknown as { stellarCoreTelemetryStarted?: TelemetryStartResult };

/**
 * Starts OTLP/HTTP export from standard, server-only OTEL_* variables. With no
 * endpoint configured nothing is registered and every instrument stays a
 * no-op. Start-up never throws. Endpoints and headers are read by the
 * exporters and are never logged.
 */
export function startTelemetryFromEnvironment(env: Environment = process.env): TelemetryStartResult {
  if (state.stellarCoreTelemetryStarted) return state.stellarCoreTelemetryStarted;
  const result = start(env);
  // Global providers can be registered only once per process.
  if (result.enabled) state.stellarCoreTelemetryStarted = result;
  return result;
}

function start(env: Environment): TelemetryStartResult {
  if (env.OTEL_SDK_DISABLED === "true") return disabled("DISABLED");

  const tracesEndpoint = env.OTEL_TRACES_EXPORTER === "none"
    ? undefined
    : env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const metricsEndpoint = env.OTEL_METRICS_EXPORTER === "none"
    ? undefined
    : env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!tracesEndpoint && !metricsEndpoint) return disabled("NOT_CONFIGURED");
  if ([tracesEndpoint, metricsEndpoint].some((endpoint) => endpoint && !isHttpUrl(endpoint))) {
    warn("TELEMETRY_INVALID_ENDPOINT");
    return disabled("INVALID_ENDPOINT");
  }

  const metricIntervalMs = positiveInteger(
    env.OTEL_METRIC_EXPORT_INTERVAL,
    DEFAULT_METRIC_EXPORT_INTERVAL_MS,
  );

  try {
    const resource = resourceFromAttributes({
      "service.name": "stellarcore",
      ...(env.VERCEL_ENV || env.NODE_ENV
        ? { "deployment.environment.name": env.VERCEL_ENV || env.NODE_ENV }
        : {}),
    }).merge(detectResources({ detectors: [envDetector] }));

    startTelemetrySdk({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(samplingRatio(env.OTEL_TRACES_SAMPLER_ARG)),
      }),
      ...(tracesEndpoint
        ? { spanExporter: new OTLPTraceExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }) }
        : {}),
      metricReaders: metricsEndpoint
        ? [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
          exportIntervalMillis: metricIntervalMs,
          // The SDK rejects a timeout longer than the export interval.
          exportTimeoutMillis: Math.min(EXPORT_TIMEOUT_MS, metricIntervalMs),
        })]
        : [],
    });

    return Object.freeze({ enabled: true, traces: Boolean(tracesEndpoint), metrics: Boolean(metricsEndpoint) });
  } catch {
    warn("TELEMETRY_START_FAILURE");
    return disabled("START_FAILURE");
  }
}

/** Parent-based trace-id ratio; defaults to 1 (sample every root trace). */
export function samplingRatio(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function disabled(reason: NonNullable<TelemetryStartResult["reason"]>): TelemetryStartResult {
  return Object.freeze({ enabled: false, traces: false, metrics: false, reason });
}

function warn(code: string): void {
  console.warn(JSON.stringify({ level: "warn", component: "telemetry", code }));
}
