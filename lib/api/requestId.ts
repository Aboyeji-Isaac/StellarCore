/**
 * Non-sensitive request correlation identifiers for public API responses.
 *
 * Why this exists: a user who reports a failed API call can quote the returned
 * identifier, and an operator can find the matching single-line server log
 * entry without the response ever carrying a stack trace, credential, or raw
 * database message.
 *
 * Trust boundary: an inbound `X-Request-Id` is client-controlled, so it is only
 * adopted when it matches a strict short pattern (`8..64` characters of
 * `[A-Za-z0-9._-]`, starting with an alphanumeric). Anything else - newlines,
 * quotes, URLs, oversized values - is replaced by a freshly generated id, which
 * keeps log-injection and forged-identifier attempts out of both the response
 * and the structured log line. A propagated id is a correlation hint, never an
 * authorization claim.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";

const REQUEST_ID_MIN_LENGTH = 8;
const REQUEST_ID_MAX_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRequestId(value: string): boolean {
  return value.length >= REQUEST_ID_MIN_LENGTH
    && value.length <= REQUEST_ID_MAX_LENGTH
    && REQUEST_ID_PATTERN.test(value);
}

/** 128 random bits rendered as hex or a UUID; both satisfy `isValidRequestId`. */
export function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns the validated inbound id when present, otherwise a fresh id.
 * An invalid inbound value is never echoed back to the caller.
 */
export function resolveRequestId(
  request: Request | null | undefined,
  options: Readonly<{ generate?: () => string }> = {},
): string {
  const inbound = request?.headers.get(REQUEST_ID_HEADER)?.trim();
  if (inbound && isValidRequestId(inbound)) return inbound;

  return (options.generate ?? createRequestId)();
}

export function requestIdHeaders(requestId: string): Readonly<Record<string, string>> {
  return { [REQUEST_ID_HEADER]: requestId };
}
