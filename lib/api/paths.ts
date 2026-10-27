/**
 * URL path parameter decoding and validation utilities for public evidence routes.
 *
 * Protects route boundaries from malformed percent-encoding, low-level parser exceptions,
 * control character injection, and unintended resource lookups.
 */

export type SafePathSegmentResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{
      ok: false;
      reason: "malformed_encoding" | "invalid_type" | "forbidden_character";
    }>;

/**
 * Safely decodes a URL path segment.
 *
 * - Returns the decoded string if valid UTF-8 percent-encoding.
 * - Catches URIError and parser exceptions on malformed sequences (e.g. %, %ZZ, %E0%A4%A, %c0%af).
 * - Rejects null bytes (%00) and other ASCII control characters.
 * - Never throws or exposes internal parser stack traces.
 */
export function safeDecodePathSegment(segment: unknown): SafePathSegmentResult {
  if (typeof segment !== "string" || segment.length === 0) {
    return Object.freeze({ ok: false, reason: "invalid_type" });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return Object.freeze({ ok: false, reason: "malformed_encoding" });
  }

  // Reject null bytes and ASCII control characters (0x00-0x1F, 0x7F)
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return Object.freeze({ ok: false, reason: "forbidden_character" });
    }
  }

  return Object.freeze({ ok: true, value: decoded });
}
