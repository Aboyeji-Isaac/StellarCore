import {
  PUBLIC_API_ERROR_STATUS_BY_CODE,
  type PublicApiErrorCode,
  type PublicApiErrorEnvelope,
  type PublicApiErrorResult,
} from "@/types/api/errors";

export function publicApiErrorEnvelope<Code extends PublicApiErrorCode>(
  code: Code,
  message: string,
): PublicApiErrorEnvelope<Code> {
  return Object.freeze({ error: Object.freeze({ code, message }) });
}

export function publicApiErrorResult<Code extends PublicApiErrorCode>(
  code: Code,
  message: string,
): PublicApiErrorResult<Code> {
  return Object.freeze({
    status: PUBLIC_API_ERROR_STATUS_BY_CODE[code],
    body: publicApiErrorEnvelope(code, message),
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

export const consolePublicApiErrorReporter: PublicApiErrorReporter = (error, context) => {
  const operation = (context && typeof context.operation === "string" && context.operation) || "unknown";
  const code = (context && typeof context.code === "string" && context.code) || "internal_error";
  console.error(
    `[stellarcore:public-api] ${operation} failed (${code})`,
    error,
  );
};

