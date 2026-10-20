export const REQUEST_ID_HEADER = "x-request-id";
export const MAX_REQUEST_ID_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Validates that an incoming request ID is safe, well-formed, and free from
 * injection characters, control characters, or excessive length.
 */
export function isValidRequestId(id: unknown): id is string {
  if (typeof id !== "string") {
    return false;
  }
  if (id.length === 0 || id.length > MAX_REQUEST_ID_LENGTH) {
    return false;
  }
  return REQUEST_ID_PATTERN.test(id);
}

/**
 * Generates a fresh cryptographically random v4 UUID for request tracing.
 * It is not derived from secrets or user input.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Resolves a request ID by preserving a valid incoming ID or generating
 * a fresh random UUID if missing, malformed, or unsafe.
 */
export function resolveRequestId(incomingId: unknown): string {
  if (isValidRequestId(incomingId)) {
    return incomingId;
  }
  return generateRequestId();
}
