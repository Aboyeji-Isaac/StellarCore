/**
 * Public API request-correlation identifiers.
 *
 * A correlation id lets an operator match a user-reported failure to the
 * structured server log entry for the same request. It is a diagnostic hint
 * only: it never carries authorization meaning, and it is never trusted
 * because a client sent it.
 *
 * Trust boundary:
 * - An inbound `X-Request-Id` is accepted only when it matches a narrow
 *   character set and length window, so a client cannot inject quotes,
 *   newlines, URLs, connection strings, or oversized values into a response
 *   header or a log line.
 * - Anything else is replaced with a freshly generated id. The original value
 *   is never echoed back.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";
export const MIN_REQUEST_ID_LENGTH = 8;
export const MAX_REQUEST_ID_LENGTH = 64;

/** Alphanumeric start, then a conservative id charset (`._-` allowed). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let fallbackCounter = 0;

/**
 * Accepts only opaque, log-safe identifiers. Values that could break a header,
 * a log line, or reader assumptions (whitespace, control characters, quotes,
 * URLs, path traversal, very short or very long strings) are rejected.
 */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= MIN_REQUEST_ID_LENGTH
    && value.length <= MAX_REQUEST_ID_LENGTH
    && REQUEST_ID_PATTERN.test(value);
}

/** Generates a new id that always satisfies {@link isValidRequestId}. */
export function createRequestId(): string {
  const source = globalThis.crypto;

  if (source && typeof source.randomUUID === "function") {
    try {
      const generated = source.randomUUID();
      if (isValidRequestId(generated)) return generated;
    } catch {
      // Fall through to the next available randomness source.
    }
  }

  if (source && typeof source.getRandomValues === "function") {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      return `req-${toHex(bytes)}`;
    } catch {
      // Fall through to the monotonic fallback below.
    }
  }

  // Last resort: never fails, still unique per process and id-shaped.
  fallbackCounter += 1;
  return `req-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/**
 * Resolves the correlation id for a request.
 *
 * A valid inbound id is propagated so clients and proxies can follow their own
 * trace; otherwise a new id is generated. The returned value is always valid.
 */
export function resolveRequestId(request: Request): string {
  const inbound = request.headers.get(REQUEST_ID_HEADER);
  return isValidRequestId(inbound) ? inbound : createRequestId();
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}
