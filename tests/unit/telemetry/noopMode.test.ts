import assert from "node:assert/strict";
import test from "node:test";

import { metrics, trace } from "@opentelemetry/api";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import { flushTelemetry, currentTraceContext } from "@/lib/telemetry/core";
import { samplingRatio, startTelemetryFromEnvironment } from "@/lib/telemetry/node";
import { withRouteTelemetry } from "@/lib/telemetry/route";
import {
  errorTypeOf,
  sanitizeAttributes,
  sanitizeSpanName,
} from "@/lib/telemetry/semantics";

// No SDK is registered in this process: this is the default production state
// whenever OTEL_* export variables are absent.

test("without exporter configuration telemetry does not start", () => {
  assert.deepEqual(startTelemetryFromEnvironment({}), {
    enabled: false,
    traces: false,
    metrics: false,
    reason: "NOT_CONFIGURED",
  });
  assert.equal(startTelemetryFromEnvironment({
    OTEL_SDK_DISABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
  }).reason, "DISABLED");
  assert.equal(startTelemetryFromEnvironment({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
  }).reason, "NOT_CONFIGURED");
});

test("an invalid endpoint disables telemetry without printing the endpoint", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const result = startTelemetryFromEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://user:secret@collector.example",
    });
    assert.equal(result.reason, "INVALID_ENDPOINT");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, [
    JSON.stringify({ level: "warn", component: "telemetry", code: "TELEMETRY_INVALID_ENDPOINT" }),
  ]);
  const delegate = (trace.getTracerProvider() as unknown as { getDelegate: () => object }).getDelegate();
  assert.equal(delegate.constructor.name, "NoopTracerProvider");
});

test("instrumented routes and refresh behave identically in no-op mode", async () => {
  const response = await withRouteTelemetry("/api/rates", async () =>
    Response.json({ error: { code: "invalid_corridor" } }, { status: 400 }))();
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "invalid_corridor" } });

  const result = await runScheduledRefresh({
    now: () => new Date("2026-09-29T00:00:00.000Z"),
    snapshotRates: async () => ({
      totalCandidates: 0, totalAttempted: 0, succeeded: 0, failed: 0, skipped: 0,
      snapshotsPersisted: 0, snapshots: [], failures: [], skippedSources: [],
    }),
    evaluateReputation: async () => ({ attempted: 0, succeeded: 0, failed: 0, failures: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(currentTraceContext(), undefined);
  await flushTelemetry();
  assert.equal(metrics.getMeterProvider().constructor.name, "NoopMeterProvider");
});

test("sampling ratio accepts only values in [0, 1]", () => {
  assert.equal(samplingRatio(undefined), 1);
  assert.equal(samplingRatio("0.25"), 0.25);
  assert.equal(samplingRatio("0"), 0);
  assert.equal(samplingRatio("1.5"), 1);
  assert.equal(samplingRatio("abc"), 1);
});

test("attribute sanitizing keeps only bounded vocabulary values", () => {
  assert.deepEqual(sanitizeAttributes({
    "http.route": "/api/anchors/[slug]",
    "http.response.status_code": 200,
    "http.target": "/api/anchors/zeam",
    "url.full": "https://example.com/x",
    "db.query.text": "SELECT 1",
    "stellarcore.result": "https://host",
    "error.type": "x".repeat(65),
    "stellarcore.sep.operation": "price",
  }), {
    "http.route": "/api/anchors/[slug]",
    "http.response.status_code": 200,
    "stellarcore.sep.operation": "price",
  });
  assert.equal(sanitizeSpanName("fetch GET https://anchor.example/sep38/price?x=1"), "fetch GET");
  assert.equal(sanitizeSpanName("GET /api/rates?corridor=a"), "GET /api/rates");
  assert.equal(sanitizeSpanName("GET /api/anchors/[slug]"), "GET /api/anchors/[slug]");
  assert.equal(sanitizeSpanName("executing api route (app) /api/rates/route"), "executing api route (app) /api/rates/route");
  assert.equal(sanitizeSpanName("<script>"), "redacted");
  assert.equal(errorTypeOf({ code: "TIMEOUT" }), "TIMEOUT");
  assert.equal(errorTypeOf({ code: "timeout https://x" }), "_OTHER");
  assert.equal(errorTypeOf(new Error("boom")), "_OTHER");
});
