import type { Attributes } from "@opentelemetry/api";
import {
  MetricReader,
  type DataPoint,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { startTelemetrySdk, type TelemetrySdk } from "@/lib/telemetry/sdk";

/** Collects metrics only when a test asks, so assertions are deterministic. */
class ManualMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

export type TestTelemetry = Readonly<{
  sdk: TelemetrySdk;
  spans: () => readonly ReadableSpan[];
  resetSpans: () => void;
  points: (metricName: string) => Promise<readonly DataPoint<unknown>[]>;
}>;

/**
 * Registers the real SDK with an in-memory span exporter behind the same
 * redacting exporter production uses, so tests observe exactly what would be
 * exported. Call once per test file (each file runs in its own process).
 */
export function installTestTelemetry(): TestTelemetry {
  const spanExporter = new InMemorySpanExporter();
  const reader = new ManualMetricReader();
  const sdk = startTelemetrySdk({
    spanExporter,
    spanProcessing: "simple",
    metricReaders: [reader],
  });

  return Object.freeze({
    sdk,
    spans: () => spanExporter.getFinishedSpans(),
    resetSpans: () => spanExporter.reset(),
    points: async (metricName: string) => {
      const { resourceMetrics } = await reader.collect();
      return dataPoints(resourceMetrics, metricName);
    },
  });
}

function dataPoints(resourceMetrics: ResourceMetrics, name: string): readonly DataPoint<unknown>[] {
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints as DataPoint<unknown>[]));
}

export function findSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) throw new Error(`span not exported: ${name}; got ${spans.map((s) => s.name).join(", ")}`);
  return span;
}

export function isChildOf(child: ReadableSpan, parent: ReadableSpan): boolean {
  return child.parentSpanContext?.spanId === parent.spanContext().spanId &&
    child.spanContext().traceId === parent.spanContext().traceId;
}

export function pointWith(
  points: readonly DataPoint<unknown>[],
  attributes: Attributes,
): DataPoint<unknown> | undefined {
  return points.find((point) => Object.entries(attributes)
    .every(([key, value]) => point.attributes[key] === value));
}

/** Everything a telemetry backend would receive about spans, as text. */
export function exportedText(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    links: span.links.map((link) => link.attributes ?? {}),
  })));
}
