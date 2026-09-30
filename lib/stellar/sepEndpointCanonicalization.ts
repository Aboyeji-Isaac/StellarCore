/**
 * Canonicalizes and validates Stellar SEP service endpoint URLs.
 *
 * Enforces strict security boundaries before persistence and trust comparison:
 * 1. Must use HTTPS protocol (plain HTTP, javascript, data, etc. rejected).
 * 2. Userinfo (username:password) is strictly disallowed to prevent credential leakage.
 * 3. URL fragments (#hash) are strictly disallowed as service endpoints are protocol APIs.
 * 4. Default HTTPS port 443 is normalized and stripped.
 * 5. Hostname is lowercased and trailing dots are removed.
 * 6. Paths are normalized: duplicate slashes are collapsed, dot segments resolved, and trailing slashes stripped.
 * 7. Query parameters are sorted deterministically if present; empty queries stripped.
 */

export class SepEndpointValidationError extends Error {
  readonly code:
    | "INVALID_URL"
    | "SCHEME_NOT_HTTPS"
    | "USERINFO_DISALLOWED"
    | "FRAGMENT_DISALLOWED"
    | "INVALID_PORT"
    | "INVALID_PATH"
    | "AMBIGUOUS_HOST";

  constructor(
    code:
      | "INVALID_URL"
      | "SCHEME_NOT_HTTPS"
      | "USERINFO_DISALLOWED"
      | "FRAGMENT_DISALLOWED"
      | "INVALID_PORT"
      | "INVALID_PATH"
      | "AMBIGUOUS_HOST",
    message: string,
  ) {
    super(message);
    this.name = "SepEndpointValidationError";
    this.code = code;
  }
}

export interface CanonicalizeOptions {
  allowLocalhostPorts?: boolean;
}

export function canonicalizeSepEndpoint(
  rawUrl: string,
  options: CanonicalizeOptions = {},
): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new SepEndpointValidationError(
      "INVALID_URL",
      "Endpoint URL must be a non-empty string",
    );
  }

  const trimmed = rawUrl.trim();

  // Fast-fail if raw string contains fragment symbol
  if (trimmed.includes("#")) {
    throw new SepEndpointValidationError(
      "FRAGMENT_DISALLOWED",
      `Endpoint URL contains disallowed fragment identifier: "${rawUrl}"`,
    );
  }

  // Reject path traversal attempts like /../ that attempt to escape or manipulate paths
  const rawPath = trimmed.replace(/^[a-zA-Z]+:\/\/[^/]+/, "");
  if (rawPath.startsWith("/../") || rawPath === "/.." || rawPath.includes("/../") || rawPath.endsWith("/..")) {
    throw new SepEndpointValidationError(
      "INVALID_PATH",
      `Path traversal escapes or manipulates root: "${rawUrl}"`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SepEndpointValidationError(
      "INVALID_URL",
      `Malformed endpoint URL: "${rawUrl}"`,
    );
  }

  // 1. Protocol check
  if (parsed.protocol !== "https:") {
    throw new SepEndpointValidationError(
      "SCHEME_NOT_HTTPS",
      `Endpoint URL must use https: scheme, found: "${parsed.protocol}"`,
    );
  }

  // 2. Userinfo check
  if (parsed.username || parsed.password) {
    throw new SepEndpointValidationError(
      "USERINFO_DISALLOWED",
      `Endpoint URL must not contain user credentials/userinfo: "${rawUrl}"`,
    );
  }

  // 3. Port check
  if (parsed.port) {
    if (parsed.port === "443") {
      // Default port for HTTPS, strip it
      parsed.port = "";
    } else {
      const isLocalhost =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";

      if (!(options.allowLocalhostPorts && isLocalhost)) {
        throw new SepEndpointValidationError(
          "INVALID_PORT",
          `Non-standard port "${parsed.port}" is not permitted for SEP endpoints`,
        );
      }
    }
  }

  // 4. Hostname normalization
  let hostname = parsed.hostname.toLowerCase();
  while (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }

  if (!hostname || hostname.includes(" ")) {
    throw new SepEndpointValidationError(
      "AMBIGUOUS_HOST",
      `Invalid or ambiguous hostname: "${parsed.hostname}"`,
    );
  }

  parsed.hostname = hostname;

  // 5. Path normalization
  // Normalize consecutive slashes e.g. // -> / and dot segments
  let pathname = parsed.pathname;
  if (!pathname || pathname === "") {
    pathname = "/";
  }

  // Resolve multiple consecutive slashes
  pathname = pathname.replace(/\/{2,}/g, "/");

  // Check for path traversal attempts or ambiguous forms
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const resolvedSegments: string[] = [];

  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (resolvedSegments.length === 0) {
        throw new SepEndpointValidationError(
          "INVALID_PATH",
          `Path traversal escapes root: "${rawUrl}"`,
        );
      }
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(seg);
    }
  }

  // Reconstruct path
  const canonicalPath = resolvedSegments.length > 0 ? `/${resolvedSegments.join("/")}` : "";

  // 6. Query normalization (sort keys deterministically)
  let canonicalQuery = "";
  if (parsed.search) {
    const searchParams = new URLSearchParams(parsed.search);
    const keys = Array.from(new Set(searchParams.keys())).sort();
    const sortedParams = new URLSearchParams();
    for (const key of keys) {
      const values = searchParams.getAll(key).sort();
      for (const val of values) {
        sortedParams.append(key, val);
      }
    }
    const queryString = sortedParams.toString();
    if (queryString) {
      canonicalQuery = `?${queryString}`;
    }
  }

  // Combine: https://hostname[:port]/path[?query]
  const portSuffix = parsed.port ? `:${parsed.port}` : "";
  return `https://${hostname}${portSuffix}${canonicalPath}${canonicalQuery}`;
}

/**
 * Compares two SEP endpoint URLs after canonicalization.
 * Returns true if both endpoints represent the exact same semantic identity.
 */
export function areSepEndpointsEquivalent(
  endpointA: string,
  endpointB: string,
  options?: CanonicalizeOptions,
): boolean {
  try {
    const canonicalA = canonicalizeSepEndpoint(endpointA, options);
    const canonicalB = canonicalizeSepEndpoint(endpointB, options);
    return canonicalA === canonicalB;
  } catch {
    return false;
  }
}
