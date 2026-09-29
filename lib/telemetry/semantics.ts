import type { Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * Bounded telemetry vocabulary. Every exported span attribute and metric
 * label must use a key from ALLOWED_ATTRIBUTE_KEYS and a short, token-like
 * value. Raw URLs, hosts, slugs, SQL text, payloads, headers, and connection
 * strings are never valid values. See docs/observability.md.
 *
 * Telemetry describes StellarCore's own execution. It is not evidence that an
 * anchor is reachable, a quote is correct, or a transfer succeeded.
 */
export const INSTRUMENTATION_SCOPE = "stellarcore";

export const PUBLIC_ROUTE_TEMPLATES = Object.freeze([
  "/api/anchors",
  "/api/anchors/[slug]",
  "/api/corridors",
  "/api/corridors/[slug]",
  "/api/rates",
  "/api/reputation",
  "/api/reputation/[slug]",
  "/api/internal/cron/refresh",
] as const);

export type RouteTemplate = (typeof PUBLIC_ROUTE_TEMPLATES)[number];

export type RefreshPhase = "rates" | "reputation";
export type SepOperation = "toml" | "info" | "prices" | "price" | "quote" | "other";

export const ATTR = Object.freeze({
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatusCode: "http.response.status_code",
  errorType: "error.type",
  dbSystem: "db.system.name",
  dbOperation: "db.operation.name",
  dbCollection: "db.collection.name",
  dbClient: "stellarcore.db.client",
  dbConnectionState: "db.client.connection.state",
  dbPoolName: "db.client.connection.pool.name",
  result: "stellarcore.result",
  sep: "stellarcore.sep",
  sepOperation: "stellarcore.sep.operation",
  refreshPhase: "stellarcore.refresh.phase",
  refreshItemResult: "stellarcore.refresh.item_result",
  freshnessState: "stellarcore.freshness.state",
} as const);

/**
 * Keys that may leave the process. Next.js built-in span attributes that
 * carry only route templates or methods are kept; `http.target`, `http.url`,
 * `url.full`, peer addresses, and anything unlisted are dropped.
 */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(ATTR),
  "http.method",
  "http.status_code",
  "next.route",
  "next.span_name",
  "next.span_type",
  "next.rsc",
  "next.segment",
  "next.page",
]);

const MAX_VALUE_LENGTH = 64;
// Token-like values only: route templates, enum codes, operation names.
const SAFE_STRING = /^[A-Za-z0-9_.\-/[\]() :$]*$/;

export const METRIC = Object.freeze({
  httpDuration: "http.server.request.duration",
  httpActive: "http.server.active_requests",
  dbDuration: "db.client.operation.duration",
  dbConnections: "db.client.connection.count",
  dbPending: "db.client.connection.pending_requests",
  sepDuration: "stellarcore.sep.request.duration",
  refreshRuns: "stellarcore.refresh.runs",
  refreshRunDuration: "stellarcore.refresh.run.duration",
  refreshPhaseDuration: "stellarcore.refresh.phase.duration",
  refreshPhaseItems: "stellarcore.refresh.phase.items",
  rateObservations: "stellarcore.rate.observations",
  rateObservationAge: "stellarcore.rate.observation.age",
} as const);

/** Seconds. Semantic-convention HTTP buckets extended for long refresh runs. */
export const DURATION_BUCKETS_SECONDS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 120, 300,
]);

/** Seconds. Observation ages from one minute to one week. */
export const AGE_BUCKETS_SECONDS = Object.freeze([
  60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400, 129600, 172800, 604800,
]);

export function isSafeAttributeValue(value: AttributeValue | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  return value.length <= MAX_VALUE_LENGTH && SAFE_STRING.test(value) && !value.includes("//");
}

/** Allowlist filter applied to every exported span and every metric label. */
export function sanitizeAttributes(attributes: Attributes | undefined): Attributes {
  const safe: Attributes = {};
  if (!attributes) return safe;
  for (const [key, value] of Object.entries(attributes)) {
    if (ALLOWED_ATTRIBUTE_KEYS.has(key) && isSafeAttributeValue(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Span names are kept only up to the first URL or query string, so Next.js
 * fetch spans such as `fetch GET https://host/path?x=y` export as `fetch GET`.
 */
export function sanitizeSpanName(name: string): string {
  const cut = name.search(/[a-z][a-z0-9+.-]*:\/\/|\?/i);
  const trimmed = (cut === -1 ? name : name.slice(0, cut)).trim().slice(0, 120);
  return trimmed.length > 0 && SAFE_STRING.test(trimmed) ? trimmed : "redacted";
}

/** Maps a typed failure code to a bounded `error.type` value. */
export function errorTypeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,47}$/.test(code)) return code;
  }
  return "_OTHER";
}
