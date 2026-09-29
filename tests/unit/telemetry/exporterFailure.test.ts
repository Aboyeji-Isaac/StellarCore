import assert from "node:assert/strict";
import { after, test } from "node:test";

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { flushTelemetry } from "@/lib/telemetry/core";
import { withRouteTelemetry } from "@/lib/telemetry/route";
import { RedactingSpanExporter, startTelemetrySdk } from "@/lib/telemetry/sdk";

// Port 1 on loopback refuses connections: the collector is unavailable.
const UNAVAILABLE = "http://127.0.0.1:1";
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (message: string) => { warnings.push(String(message)); };

const sdk = startTelemetrySdk({
  spanExporter: new OTLPTraceExporter({ url: `${UNAVAILABLE}/v1/traces`, timeoutMillis: 500 }),
  metricReaders: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${UNAVAILABLE}/v1/metrics`, timeoutMillis: 500 }),
    exportIntervalMillis: 60_000,
    exportTimeoutMillis: 500,
  })],
});

after(async () => {
  await Promise.race([sdk.shutdown(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  console.warn = originalWarn;
});

test("requests succeed and flushing stays bounded when the collector is unavailable", async () => {
  const handler = withRouteTelemetry("/api/anchors", async () =>
    Response.json({ anchors: [] }, { status: 200 }));

  const responses = await Promise.all(Array.from({ length: 25 }, () => handler()));
  assert.ok(responses.every((response) => response.status === 200));

  const startedAt = performance.now();
  await flushTelemetry(1_500);
  assert.ok(performance.now() - startedAt < 2_500, "flush must respect its time bound");

  for (const warning of warnings) {
    assert.equal(warning, JSON.stringify({
      level: "warn",
      component: "telemetry",
      code: "TELEMETRY_EXPORT_FAILURE",
    }), "only the fixed diagnostic line may be printed");
  }
});

test("an exporter that throws reports a failed export instead of throwing", async () => {
  const throwing: SpanExporter = {
    export: () => { throw new Error("exporter crashed"); },
    shutdown: async () => undefined,
  };
  const result = await new Promise<ExportResult>((resolve) => {
    new RedactingSpanExporter(throwing).export([] as ReadableSpan[], resolve);
  });
  assert.equal(result.code, ExportResultCode.FAILED);
});

test("a flush that never settles is abandoned at the time bound", async () => {
  const { registerTelemetryFlush } = await import("@/lib/telemetry/core");
  registerTelemetryFlush(() => new Promise<void>(() => undefined));
  try {
    const startedAt = performance.now();
    await flushTelemetry(100);
    assert.ok(performance.now() - startedAt < 1_000);
  } finally {
    registerTelemetryFlush(sdk.forceFlush);
  }
});
