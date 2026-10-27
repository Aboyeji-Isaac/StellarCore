import {
  PUBLIC_API_ERROR_STATUS_BY_CODE,
  type PublicApiErrorCode,
  type PublicApiErrorEnvelope,
  type PublicApiErrorResult,
} from "@/types/api/errors";
import { isValidRequestId } from "@/lib/api/requestId";

/**
 * Builds the public error envelope.
 *
 * Only the documented safe fields are ever published: `code`, `message`, and an
 * optional correlation `requestId`. The id is re-validated here (not just at
 * the route boundary) so a forged or malformed value can never reach a client
 * even if a future caller passes one by mistake.
 */
export function publicApiErrorEnvelope<Code extends PublicApiErrorCode>(
  code: Code,
  message: string,
  requestId?: string,
): PublicApiErrorEnvelope<Code> {
  const error = isValidRequestId(requestId)
    ? { code, message, requestId }
    : { code, message };
  return Object.freeze({ error: Object.freeze(error) });
}

export function publicApiErrorResult<Code extends PublicApiErrorCode>(
  code: Code,
  message: string,
  requestId?: string,
): PublicApiErrorResult<Code> {
  return Object.freeze({
    status: PUBLIC_API_ERROR_STATUS_BY_CODE[code],
    body: publicApiErrorEnvelope(code, message, requestId),
  });
}

export type PublicApiErrorContext = Readonly<{
  operation?: string | undefined;
  code?: PublicApiErrorCode | string | undefined;
  requestId?: string | undefined;
  [key: string]: unknown;
}>;

export type PublicApiErrorReporter = (
  error: unknown,
  context?: PublicApiErrorContext | undefined,
) => void;

/**
 * Writes one structured, single-line log entry per public API failure.
 *
 * The correlation id published to the client is included in the same entry, so
 * an operator can find the failure from a user-reported reference. The original
 * error object is kept as the second argument: operators retain the server-side
 * stack, while the client body only ever carries code, message, and the id.
 */
export const consolePublicApiErrorReporter: PublicApiErrorReporter = (error, context) => {
  const operation = (context && typeof context.operation === "string" && context.operation) || "unknown";
  const code = (context && typeof context.code === "string" && context.code) || "internal_error";
  const requestId = context?.requestId;
  console.error(
    `[stellarcore:public-api] ${JSON.stringify({
      event: "public_api_error",
      operation,
      code,
      ...(isValidRequestId(requestId) ? { requestId } : {}),
    })}`,
    error,
  );
};
