import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  type DiagLogger,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  ExportResultCode,
  W3CTraceContextPropagator,
  type ExportResult,
} from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import { MeterProvider, type MetricReader } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { instruments, registerTelemetryFlush } from "@/lib/telemetry/core";
import { sanitizeAttributes, sanitizeSpanName } from "@/lib/telemetry/semantics";

/**
 * Enforces the attribute allowlist at the export boundary, so spans created by
 * Next.js or any library are redacted too: names lose URLs and query strings,
 * attributes outside the vocabulary are dropped, and events (which can carry
 * exception messages), link attributes, and status messages are removed.
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.delegate.export(spans.map(redactSpan), resultCallback);
    } catch {
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

export function redactSpan(span: ReadableSpan): ReadableSpan {
  const spanContext = span.spanContext();
  return {
    name: sanitizeSpanName(span.name),
    kind: span.kind,
    spanContext: () => spanContext,
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: sanitizeAttributes(span.attributes),
    links: span.links.map((link) => ({ context: link.context })),
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Bounded in-memory buffering: spans beyond the queue are dropped. */
export const BATCH_SPAN_LIMITS = Object.freeze({
  maxQueueSize: 2_048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 5_000,
});

export type TelemetrySdkOptions = Readonly<{
  resource?: Resource;
  sampler?: Sampler;
  spanExporter?: SpanExporter;
  /** "simple" exports each span on end; used by deterministic tests. */
  spanProcessing?: "batch" | "simple";
  metricReaders?: readonly MetricReader[];
}>;

export type TelemetrySdk = Readonly<{
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}>;

/** Registers global tracer and meter providers for this process. */
export function startTelemetrySdk(options: TelemetrySdkOptions): TelemetrySdk {
  diag.setLogger(boundedDiagLogger(), DiagLogLevel.ERROR);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const spanProcessors: SpanProcessor[] = [];
  if (options.spanExporter) {
    const exporter = new RedactingSpanExporter(options.spanExporter);
    spanProcessors.push(options.spanProcessing === "simple"
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, BATCH_SPAN_LIMITS));
  }
  const tracerProvider = new BasicTracerProvider({
    ...(options.resource ? { resource: options.resource } : {}),
    ...(options.sampler ? { sampler: options.sampler } : {}),
    spanProcessors,
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const meterProvider = new MeterProvider({
    ...(options.resource ? { resource: options.resource } : {}),
    readers: [...(options.metricReaders ?? [])],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  // Creates observable gauges now so pool pressure is collected from start.
  instruments();

  const forceFlush = async () => {
    await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
  };
  registerTelemetryFlush(forceFlush);

  return Object.freeze({
    forceFlush,
    shutdown: async () => {
      registerTelemetryFlush(undefined);
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  });
}

/**
 * OpenTelemetry's internal diagnostics can include exporter endpoints or
 * response bodies, so they are replaced by one fixed line, at most once a
 * minute. Structured logging (#58) should adopt this code when it lands.
 */
function boundedDiagLogger(): DiagLogger {
  let lastReportedAt = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReportedAt < 60_000) return;
    lastReportedAt = now;
    console.warn(JSON.stringify({ level: "warn", component: "telemetry", code: "TELEMETRY_EXPORT_FAILURE" }));
  };
  const ignore = () => undefined;
  return { error: report, warn: ignore, info: ignore, debug: ignore, verbose: ignore };
}
