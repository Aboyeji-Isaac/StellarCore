import {
  type DashboardPanelResult,
  type DashboardPanelError,
} from "./dashboardPanel";

export type DashboardFailure = DashboardPanelError;

/**
 * Creates a dashboard API error result with the given error code and message.
 * The result has status from PUBLIC_API_ERROR_STATUS_BY_CODE mapping and
 * body.error containing the code and message.
 */
export function makeDashboardApiError(
  error: { code: string; message: string },
): DashboardPanelResult<never> {
  const statusMap: Record<string, number> = {
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
  };

  const status = (error.code in statusMap ? statusMap[error.code] : 503);

  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({
        code: error.code,
        message: error.message,
      }),
    }),
  });
}

/**
 * Creates a successful dashboard API result with the given body.
 * The result has status 200 and body containing the data.
 */
export function makeDashboardApiResult<T>(
  status: 200,
  body: T,
): DashboardPanelResult<200, T> {
  return Object.freeze({
    status: 200,
    body,
  });
}

/**
 * PUBLIC_API_ERROR_STATUS_BY_CODE mapping for reference.
 * makeDashboardApiError uses these mappings.
 * withRecoverableErrors also uses these mappings for recoverable errors.
 */
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
} as const;

/**
 * Processes a sequence of dashboard API results, handling recoverable errors.
 * Non-recoverable errors pass through as-is, while recoverable errors allow
 * the sequence to continue. Returns all results in order.
 * 
 * Handles both DashboardPanelResult objects and plain error objects { code, message }.
 * Recoverable errors are mapped to their PUBLIC_API_ERROR_STATUS_BY_CODE status values.
 */
export async function withRecoverableErrors<T>(
  sequence: (DashboardPanelResult<T> | { code: string; message: string })[],
): Promise<DashboardPanelResult<T>[]> {
  const results: DashboardPanelResult<T>[] = [];

  for (const item of sequence) {
    // Handle plain error objects { code, message } (not DashboardPanelResult)
    if (
      typeof item === "object" &&
      item !== null &&
      !("status" in item) &&
      typeof item.code === "string" &&
      typeof item.message === "string"
    ) {
      const code = item.code;
      const isRecoverable = RECOVERABLE_PUBLIC_API_ERROR_CODES.includes(code);

      if (isRecoverable) {
        const errorStatus = PUBLIC_API_ERROR_STATUS_BY_CODE[code] ?? 503;
        results.push(Object.freeze({
          status: errorStatus,
          body: Object.freeze({
            error: Object.freeze({ code, message: item.message }),
          }),
        }));
      } else {
        // Non-recoverable plain error - pass through with status 500
        results.push(Object.freeze({
          status: 500,
          body: Object.freeze({
            error: Object.freeze({ code: item.code, message: item.message }),
          }),
        }));
      }
      continue;
    }

    // Handle DashboardPanelResult objects
    if ("status" in item) {
      const status = item.status;

      // Success status - pass through
      if (status === 200) {
        results.push(Object.freeze({ status: 200, body: item.body }));
        continue;
      }

      // Error status - check if recoverable
      if (typeof item.body?.error?.code === "string") {
        const code = item.body.error.code;
        const isRecoverable = RECOVERABLE_PUBLIC_API_ERROR_CODES.includes(code);

        if (isRecoverable) {
          // Map to the proper status code from the public API error status map
          const errorStatus = PUBLIC_API_ERROR_STATUS_BY_CODE[code] ?? 503;
          results.push({
            status: errorStatus,
            body: Object.freeze({
              error: Object.freeze({ code, message: item.body.error.message }),
            }),
          });
        } else {
          // Non-recoverable error - pass through as-is
          results.push(Object.freeze(item as DashboardPanelResult<T>));
        }
        continue;
      }

      // Unknown status or format - pass through as-is
      results.push(Object.freeze(item as DashboardPanelResult<T>));
    } else {
      results.push(Object.freeze(item as DashboardPanelResult<T>));
    }
  }

  return results;
}

/**
 * Checks whether a dashboard API result represents a recoverable error.
 * Only errors with codes in RECOVERABLE_PUBLIC_API_ERROR_CODES are considered recoverable.
 * Non-503 results and non-object results are not recoverable.
 */
export function isPublicApiResultRecoverable(
  result: DashboardPanelResult<unknown>,
): boolean {
  if (result.status !== 503) {
    return false;
  }

  if (typeof result.body?.error?.code !== "string") {
    return false;
  }

  const code = result.body.error.code;
  return RECOVERABLE_PUBLIC_API_ERROR_CODES.includes(code);
}

/**
 * The set of public API error codes that are considered recoverable (temporary
 * conditions rather than permanent contract violations). Only these may offer
 * a retry affordance in the UI.
 */
export const RECOVERABLE_PUBLIC_API_ERROR_CODES = [
  "internal_error",
  "upstream_unavailable",
  "rate_limited",
] as const;