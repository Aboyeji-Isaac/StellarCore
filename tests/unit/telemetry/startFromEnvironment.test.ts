import assert from "node:assert/strict";
import test from "node:test";

import { metrics, trace } from "@opentelemetry/api";

import { startTelemetryFromEnvironment } from "@/lib/telemetry/node";

test("a metric interval shorter than the export timeout still starts telemetry", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const result = startTelemetryFromEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
      OTEL_METRIC_EXPORT_INTERVAL: "1000",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test,stellarcore.synthetic=true",
    });
    assert.deepEqual(result, { enabled: true, traces: true, metrics: true });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, []);
  const delegate = (trace.getTracerProvider() as unknown as { getDelegate: () => object }).getDelegate();
  assert.equal(delegate.constructor.name, "BasicTracerProvider");
  assert.equal(metrics.getMeterProvider().constructor.name, "MeterProvider");
  // A second start is a no-op: global providers register once per process.
  assert.deepEqual(startTelemetryFromEnvironment({}), { enabled: true, traces: true, metrics: true });
});
