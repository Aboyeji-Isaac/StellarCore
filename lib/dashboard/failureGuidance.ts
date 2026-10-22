import { isValidRequestId } from "@/lib/api/requestId";

/**
 * Dashboard panels render failed live-data fetches through one mapping so the
 * wording, tone, and recovery path stay consistent. The mapping is pure and
 * defensive: public API messages are expected to be safe, but anything that
 * looks like a stack frame, credential, URL, SQL, or driver error is replaced
 * by a generic message instead of being rendered.
 */

export const DASHBOARD_DATA_AREAS = [
  "anchors",
  "corridors",
  "rates",
  "rate_history",
  "reputation",
] as const;

export type DashboardDataArea = (typeof DASHBOARD_DATA_AREAS)[number];

const AREA_LABELS: Readonly<Record<DashboardDataArea, string>> = {
  anchors: "Anchor directory",
  corridors: "Corridor directory",
  rates: "Rate evidence",
  rate_history: "Rate history",
  reputation: "Anchor reputation",
};

/** Codes where reloading the panel can plausibly succeed. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "internal_error",
  "upstream_unavailable",
  "rate_limited",
]);

const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "missing_corridor",
  "invalid_corridor",
  "invalid_days",
  "invalid_corridor_slug",
  "invalid_anchor_slug",
  "anchor_not_found",
  "corridor_not_found",
  "invalid_pagination",
  "rate_limited",
  "internal_error",
  "upstream_unavailable",
]);

const MAX_PUBLIC_MESSAGE_LENGTH = 240;

const UNSAFE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /[\u0000-\u001f\u007f]/, // newlines, tabs, stack-trace control characters
  /:\/\//, // any URL, including credential-bearing connection strings
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|prisma):/i,
  /\bDATABASE_URL\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bapi[_-]?key\b/i,
  /\btoken\b/i,
  /\bjwt\b/i,
  /\bat\s+\S+\s*\(?[^)]*:\d+:\d+\)?/, // stack frame
  /\b(?:TypeError|RangeError|PrismaClient\w*|Error):/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)\b/,
  /\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP)\s+/i,
  /[<>]/,
];

export type DashboardFailureInput = Readonly<{
  code: string;
  message: string;
  requestId?: string;
}>;

export type DashboardFailureGuidance = Readonly<{
  area: DashboardDataArea;
  areaLabel: string;
  /** Registry code, or `unknown_error` when the code is not recognized. */
  code: string;
  title: string;
  message: string;
  guidance: string;
  retry: boolean;
  /** Safe correlation reference to quote to support, when the API sent one. */
  reference: string | null;
}>;

export function isSafePublicMessage(value: string): boolean {
  return value.trim().length > 0
    && value.length <= MAX_PUBLIC_MESSAGE_LENGTH
    && !UNSAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value));
}

export function dashboardFailureGuidance(
  area: DashboardDataArea,
  failure: DashboardFailureInput,
): DashboardFailureGuidance {
  const areaLabel = AREA_LABELS[area];
  const knownCode = PUBLIC_ERROR_CODES.has(failure.code);
  const code = knownCode ? failure.code : "unknown_error";
  const retry = !knownCode || RETRYABLE_CODES.has(failure.code);
  const message = knownCode && isSafePublicMessage(failure.message)
    ? failure.message
    : `Unable to load ${areaLabel.toLowerCase()}.`;

  return Object.freeze({
    area,
    areaLabel,
    code,
    title: `${areaLabel} unavailable`,
    message,
    guidance: guidanceFor(areaLabel, code, retry),
    retry,
    reference: failure.requestId && isValidRequestId(failure.requestId)
      ? failure.requestId
      : null,
  });
}

function guidanceFor(areaLabel: string, code: string, retry: boolean): string {
  if (code === "rate_limited") {
    return "Too many requests were sent in a short window. Wait about a minute, then reload the page to retry.";
  }

  if (retry) {
    return `This panel is fetched live. Reload the page to retry; if ${areaLabel.toLowerCase()} still fails, report it with the reference below.`;
  }

  if (code === "anchor_not_found" || code === "corridor_not_found") {
    return "This record is no longer available, so retrying will not help. Return to the dashboard for the current directory.";
  }

  return "The request was rejected as invalid, so reloading will not help. Please report it with the reference below.";
}
