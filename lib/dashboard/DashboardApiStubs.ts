import {
  type DashboardPanelResult,
  type DashboardPanelError,
} from "./dashboardPanel";
import {
  PUBLIC_API_ERROR_CODES,
  PUBLIC_API_ERROR_STATUS_BY_CODE as SHARED_PUBLIC_API_ERROR_STATUS_BY_CODE,
  isRecoverablePublicApiErrorCode,
  type PublicApiErrorCode,
} from "@/types/api/errors";

export type DashboardFailure = DashboardPanelError;

function isPublicApiErrorCode(code: string): code is PublicApiErrorCode {
  return (PUBLIC_API_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Creates a dashboard API error result with the given error code and message.
 * The result has status from PUBLIC_API_ERROR_STATUS_BY_CODE mapping and
 * body.error containing the code and message.
 */
export function makeDashboardApiError(
  error: { code: string; message: string },
): DashboardPanelResult<never> {
  const code: DashboardPanelError["code"] = isPublicApiErrorCode(error.code)
    ? error.code
    : "unknown_error";

  return Object.freeze({
    status: isPublicApiErrorCode(code)
      ? SHARED_PUBLIC_API_ERROR_STATUS_BY_CODE[code]
      : 503,
    body: Object.freeze({
      error: Object.freeze({
        code,
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
): DashboardPanelResult<T> {
  return Object.freeze({
    status,
    body,
  });
}

/**
 * PUBLIC_API_ERROR_STATUS_BY_CODE mapping for reference.
 * makeDashboardApiError uses these mappings.
 * withRecoverableErrors also uses these mappings for recoverable errors.
 */
export const PUBLIC_API_ERROR_STATUS_BY_CODE = SHARED_PUBLIC_API_ERROR_STATUS_BY_CODE;

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
      const code: DashboardPanelError["code"] = isPublicApiErrorCode(item.code)
        ? item.code
        : "unknown_error";

      if (isRecoverablePublicApiErrorCode(code)) {
        results.push(Object.freeze({
          status: SHARED_PUBLIC_API_ERROR_STATUS_BY_CODE[code],
          body: Object.freeze({
            error: Object.freeze({ code, message: item.message }),
          }),
        }));
      } else {
        // Non-recoverable plain error - pass through with status 500
        results.push(Object.freeze({
          status: 500,
          body: Object.freeze({
            error: Object.freeze({ code, message: item.message }),
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

      const error = item.body.error;
      if (isRecoverablePublicApiErrorCode(error.code)) {
        // Map to the proper status code from the public API error status map
        results.push(Object.freeze({
          status: SHARED_PUBLIC_API_ERROR_STATUS_BY_CODE[error.code],
          body: Object.freeze({
            error: Object.freeze({ code: error.code, message: error.message }),
          }),
        }));
      } else {
        // Non-recoverable error - pass through as-is
        results.push(Object.freeze(item));
      }
      continue;
    }

    // Unknown status or format - pass through as-is
    results.push(Object.freeze(item as unknown as DashboardPanelResult<T>));
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

  return isRecoverablePublicApiErrorCode(result.body.error.code);
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
