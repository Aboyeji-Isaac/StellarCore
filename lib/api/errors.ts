import {
  PUBLIC_API_ERROR_STATUS_BY_CODE,
  type PublicApiErrorCode,
  type PublicApiErrorEnvelope,
  type PublicApiErrorResult,
} from "@/types/api/errors";
import { isValidRequestId } from "@/lib/api/requestId";

/**
 * `requestId` is optional: server-rendered callers may have no inbound request
 * to correlate, and the identifier is added only when a valid one is supplied.
 */
export function publicApiErrorEnvelope<Code extends PublicApiErrorCode>(
  code: Code,
  message: string,
  requestId?: string,
): PublicApiErrorEnvelope<Code> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      ...(requestId && isValidRequestId(requestId) ? { requestId } : {}),
    }),
  });
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

export type PublicApiErrorReporter = (
  error: unknown,
  context: Readonly<{
    operation: string;
    code: PublicApiErrorCode;
    requestId?: string;
  }>,
) => void;

/**
 * One JSON object per failure so the request id in the client-visible envelope
 * matches the id in the log entry. The original error object is kept as the
 * second console argument: operators retain the stack server-side while the
 * response body only ever carries the safe code, message, and id.
 */
export const consolePublicApiErrorReporter: PublicApiErrorReporter = (error, context) => {
  console.error(
    `[stellarcore:public-api] ${JSON.stringify({
      event: "public_api_error",
      requestId: context.requestId ?? null,
      operation: context.operation,
      code: context.code,
      error: describeError(error),
    })}`,
    error,
  );
};

function describeError(error: unknown): Readonly<{ name: string; message: string }> {
  if (error instanceof Error) {
    return Object.freeze({ name: error.name, message: error.message });
  }
  return Object.freeze({ name: "UnknownError", message: String(error) });
}
