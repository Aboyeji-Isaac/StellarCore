import {
  CACHE_CLASS_DIRECTIVES,
  EVIDENCE_CACHE_CLASSES,
  EVIDENCE_VARY_VALUE,
  type PublicCacheClass,
} from "@/constants/apiCachePolicy";

/**
 * Builds the response headers that implement a cache class. Evidence classes
 * also pin `Vary: Accept-Encoding` so intermediaries that negotiate
 * compression key responses explicitly instead of merging encodings, and so
 * the header contract is visible to tests rather than implied by framework
 * defaults. Every status a route can return — 2xx evidence, 4xx validation,
 * 429 rate limiting, 5xx failures, and degraded payloads — must use the same
 * headers so a negative response can never outlive the policy and mask
 * recovery.
 */
export function cacheHeadersFor(
  cacheClass: PublicCacheClass,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    "Cache-Control": CACHE_CLASS_DIRECTIVES[cacheClass],
  };
  if (EVIDENCE_CACHE_CLASSES.includes(cacheClass)) {
    headers.Vary = EVIDENCE_VARY_VALUE;
  }
  return Object.freeze(headers);
}

/** Headers for public evidence API responses (successes and errors alike). */
export const EVIDENCE_API_HEADERS = cacheHeadersFor("evidence_api");

/** Headers for the scheduled refresh endpoint's responses. */
export const INTERNAL_API_HEADERS = cacheHeadersFor("internal_api");
