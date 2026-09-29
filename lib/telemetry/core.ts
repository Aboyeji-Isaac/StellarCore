import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type MeterProvider,
  type ObservableGauge,
  type Span,
  type UpDownCounter,
} from "@opentelemetry/api";

import {
  AGE_BUCKETS_SECONDS,
  ATTR,
  DURATION_BUCKETS_SECONDS,
  errorTypeOf,
  INSTRUMENTATION_SCOPE,
  METRIC,
  sanitizeAttributes,
} from "@/lib/telemetry/semantics";

/**
 * Instrumentation helpers. Without a registered SDK every call goes to the
 * OpenTelemetry API's no-op implementation, so the default is safe and cheap.
 * No helper here lets a telemetry failure change an application result: the
 * wrapped operation's value or error is always returned unchanged.
 */

export type Instruments = Readonly<{
  httpDuration: Histogram;
  httpActive: UpDownCounter;
  dbDuration: Histogram;
  dbConnections: ObservableGauge;
  dbPending: ObservableGauge;
  sepDuration: Histogram;
  refreshRuns: Counter;
  refreshRunDuration: Histogram;
  refreshPhaseDuration: Histogram;
  refreshPhaseItems: Counter;
  rateObservations: Counter;
  rateObservationAge: Histogram;
}>;

type PoolStats = Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>;

const state = globalThis as unknown as {
  stellarCoreTelemetryInstruments?: WeakMap<MeterProvider, Instruments>;
  stellarCoreTelemetryPools?: Map<string, PoolStats>;
};

const instrumentCache = (state.stellarCoreTelemetryInstruments ??= new WeakMap());
const pools = (state.stellarCoreTelemetryPools ??= new Map());

/**
 * Instruments are created per global MeterProvider, so instruments requested
 * before the SDK registers do not stay bound to the no-op meter.
 */
export function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  const cached = instrumentCache.get(provider);
  if (cached) return cached;

  const meter = provider.getMeter(INSTRUMENTATION_SCOPE);
  const duration = (name: string, description: string) => meter.createHistogram(name, {
    description,
    unit: "s",
    advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_SECONDS] },
  });

  const created: Instruments = Object.freeze({
    httpDuration: duration(METRIC.httpDuration, "Duration of StellarCore API route handling."),
    httpActive: meter.createUpDownCounter(METRIC.httpActive, {
      description: "API requests currently in flight in this process.",
      unit: "{request}",
    }),
    dbDuration: duration(METRIC.dbDuration, "Duration of Prisma operations, including connection wait."),
    dbConnections: meter.createObservableGauge(METRIC.dbConnections, {
      description: "PostgreSQL pool connections by state.",
      unit: "{connection}",
    }),
    dbPending: meter.createObservableGauge(METRIC.dbPending, {
      description: "Queries waiting for a free PostgreSQL pool connection.",
      unit: "{request}",
    }),
    sepDuration: duration(METRIC.sepDuration, "Duration of outbound SEP-1 and SEP-38 requests."),
    refreshRuns: meter.createCounter(METRIC.refreshRuns, {
      description: "Completed scheduled refresh runs by outcome.",
      unit: "{run}",
    }),
    refreshRunDuration: duration(METRIC.refreshRunDuration, "Duration of one scheduled refresh run."),
    refreshPhaseDuration: duration(METRIC.refreshPhaseDuration, "Duration of one scheduled refresh phase."),
    refreshPhaseItems: meter.createCounter(METRIC.refreshPhaseItems, {
      description: "Items processed by a scheduled refresh phase, by result.",
      unit: "{item}",
    }),
    rateObservations: meter.createCounter(METRIC.rateObservations, {
      description: "Persisted latest-rate observations read, by evaluated freshness state.",
      unit: "{observation}",
    }),
    rateObservationAge: meter.createHistogram(METRIC.rateObservationAge, {
      description: "Age of persisted latest-rate observations at read time.",
      unit: "s",
      advice: { explicitBucketBoundaries: [...AGE_BUCKETS_SECONDS] },
    }),
  });

  created.dbConnections.addCallback((result) => {
    for (const [name, pool] of pools) {
      const base = { [ATTR.dbPoolName]: name };
      result.observe(pool.totalCount - pool.idleCount, { ...base, [ATTR.dbConnectionState]: "used" });
      result.observe(pool.idleCount, { ...base, [ATTR.dbConnectionState]: "idle" });
    }
  });
  created.dbPending.addCallback((result) => {
    for (const [name, pool] of pools) {
      result.observe(pool.waitingCount, { [ATTR.dbPoolName]: name });
    }
  });

  instrumentCache.set(provider, created);
  return created;
}

/** Registers a connection pool whose counts are observed as gauges. */
export function observeConnectionPool(name: string, pool: PoolStats): void {
  pools.set(name, pool);
}

export function recordHistogram(histogram: Histogram, value: number, attributes: Attributes): void {
  try {
    histogram.record(value, sanitizeAttributes(attributes));
  } catch {
    // Telemetry must never affect the observed operation.
  }
}

export function addCounter(counter: Counter | UpDownCounter, value: number, attributes: Attributes): void {
  try {
    counter.add(value, sanitizeAttributes(attributes));
  } catch {
    // Telemetry must never affect the observed operation.
  }
}

export function tracer() {
  return trace.getTracer(INSTRUMENTATION_SCOPE);
}

export function elapsedSeconds(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}

/**
 * Runs `operation` inside an active child span. The span ends with a bounded
 * `error.type` on failure; exception messages and stacks are never recorded
 * because they can contain URLs or payload fragments.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: sanitizeAttributes(attributes) }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      markSpanError(span, errorTypeOf(error));
      throw error;
    } finally {
      span.end();
    }
  });
}

export function markSpanError(span: Span, errorType: string): void {
  span.setAttribute(ATTR.errorType, errorType);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Trace identifiers for log correlation. The structured logger from #58 should
 * add these fields to each record once it lands; no competing log format is
 * introduced here.
 */
export function currentTraceContext(): Readonly<{ traceId: string; spanId: string }> | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  if (!context || !trace.isSpanContextValid(context)) return undefined;
  return Object.freeze({ traceId: context.traceId, spanId: context.spanId });
}

const flushState = globalThis as unknown as {
  stellarCoreTelemetryFlush?: () => Promise<void>;
};

/** Called by the SDK bootstrap; absent when telemetry is disabled. */
export function registerTelemetryFlush(flush: (() => Promise<void>) | undefined): void {
  flushState.stellarCoreTelemetryFlush = flush;
}

export const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Flushes buffered telemetry with a hard time bound. Resolves on success,
 * failure, or timeout alike, so callers can never be blocked or failed by an
 * unavailable exporter.
 */
export async function flushTelemetry(timeoutMs = TELEMETRY_FLUSH_TIMEOUT_MS): Promise<void> {
  const flush = flushState.stellarCoreTelemetryFlush;
  if (!flush) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flush().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
