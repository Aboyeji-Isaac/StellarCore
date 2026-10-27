export const PUBLIC_API_ERROR_CODES = [
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
] as const;

export type PublicApiErrorCode = (typeof PUBLIC_API_ERROR_CODES)[number];
export type PublicApiErrorStatus = 400 | 404 | 429 | 500 | 503;

export const PUBLIC_API_ERROR_STATUS_BY_CODE = {
  missing_corridor: 400,
  invalid_corridor: 400,
  invalid_days: 400,
  invalid_corridor_slug: 400,
  invalid_anchor_slug: 400,
  anchor_not_found: 404,
  corridor_not_found: 404,
  invalid_pagination: 400,
  rate_limited: 429,
  internal_error: 500,
  upstream_unavailable: 503,
} as const satisfies Readonly<Record<PublicApiErrorCode, PublicApiErrorStatus>>;

export type PublicApiErrorEnvelope<Code extends PublicApiErrorCode = PublicApiErrorCode> = Readonly<{
  error: Readonly<{
    code: Code;
    message: string;
    /**
     * Correlation id for this failure. Present only when the route resolved a
     * valid id; it is additive, so clients that ignore it keep working, and it
     * never contains internal diagnostics.
     */
    requestId?: string;
  }>;
}>;

export function isPublicApiErrorCode(value: unknown): value is PublicApiErrorCode {
  return typeof value === "string"
    && (PUBLIC_API_ERROR_CODES as readonly string[]).includes(value);
}

export type PublicApiErrorResult<Code extends PublicApiErrorCode = PublicApiErrorCode> = Readonly<{
  status: (typeof PUBLIC_API_ERROR_STATUS_BY_CODE)[Code];
  body: PublicApiErrorEnvelope<Code>;
}>;

/** Failure codes that describe a temporary condition rather than a permanent
 * contract violation. Only these may offer a retry affordance in the UI: a
 * missing corridor or an invalid request will fail identically on every
 * attempt, so offering "retry" there would be misleading.
 */
export const RECOVERABLE_PUBLIC_API_ERROR_CODES = Object.freeze([
  "internal_error",
  "upstream_unavailable",
  "rate_limited",
] as const);

export type RecoverablePublicApiErrorCode = (typeof RECOVERABLE_PUBLIC_API_ERROR_CODES)[number];

export function isRecoverablePublicApiErrorCode(
  code: string,
): code is RecoverablePublicApiErrorCode {
  return (RECOVERABLE_PUBLIC_API_ERROR_CODES as readonly string[]).includes(code);
}

/** Checks whether a dashboard API result represents a recoverable error.
 * Only errors with codes in RECOVERABLE_PUBLIC_API_ERROR_CODES are considered recoverable.
 * Non-object results and results without an error code are not recoverable.
 */
export function isPublicApiResultRecoverable(
  result: unknown,
): boolean {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const body = (result as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && isRecoverablePublicApiErrorCode(code);
}