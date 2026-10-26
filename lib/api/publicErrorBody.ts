/**
 * Narrow reader for an untrusted public error body (for example a `fetch`
 * response in a client component).
 *
 * Only the three documented safe fields are extracted, and only when they are
 * strings. Everything else in the payload is dropped, so a caller can never
 * accidentally render unrelated or internal content from a malformed or
 * unexpected response.
 */

export type PublicErrorBodyFields = Readonly<{
  code?: string;
  message?: string;
  requestId?: string;
}>;

export function readPublicErrorBody(value: unknown): PublicErrorBodyFields {
  if (typeof value !== "object" || value === null) return Object.freeze({});
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return Object.freeze({});

  const { code, message, requestId } = error as {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };

  return Object.freeze({
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
  });
}
