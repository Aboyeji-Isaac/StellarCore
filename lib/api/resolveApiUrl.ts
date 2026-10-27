/**
 * API URL resolution for dashboard and client requests.
 *
 * Ensures consistent target origin across local, preview, and production environments,
 * deduplicates path prefixes, safely validates configuration, and supports explicit
 * relative-path strategies.
 */

export type ApiUrlResolutionStrategy = "configured-origin" | "relative";

export type ApiUrlResolutionConfig = Readonly<{
  baseUrl?: string;
  strategy?: ApiUrlResolutionStrategy;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export class InvalidApiUrlConfigurationError extends Error {
  readonly code = "INVALID_API_URL_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "InvalidApiUrlConfigurationError";
  }
}

/**
 * Sanitizes and normalizes an input path to guarantee a single leading slash.
 */
function normalizePath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new InvalidApiUrlConfigurationError("API path must be a non-empty string.");
  }
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Resolves the raw base URL string from configuration or environment.
 */
function extractRawBaseUrl(config?: ApiUrlResolutionConfig): string | undefined {
  if (config?.baseUrl !== undefined) {
    const trimmed = config.baseUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const env = config?.env ?? (typeof process !== "undefined" ? process.env : {});

  if (env.NEXT_PUBLIC_API_URL && env.NEXT_PUBLIC_API_URL.trim().length > 0) {
    return env.NEXT_PUBLIC_API_URL.trim();
  }

  if (env.NEXT_PUBLIC_APP_URL && env.NEXT_PUBLIC_APP_URL.trim().length > 0) {
    return env.NEXT_PUBLIC_APP_URL.trim();
  }

  if (env.VERCEL_URL && env.VERCEL_URL.trim().length > 0) {
    const vercel = env.VERCEL_URL.trim();
    return vercel.startsWith("http://") || vercel.startsWith("https://")
      ? vercel
      : `https://${vercel}`;
  }

  return undefined;
}

/**
 * Validates and parses the base URL into a validated URL object.
 */
function parseAndValidateBaseUrl(rawBase: string): URL {
  if (rawBase.startsWith("//")) {
    throw new InvalidApiUrlConfigurationError(
      "Base URL must include an explicit http or https protocol.",
    );
  }

  let candidate = rawBase;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (candidate.startsWith("localhost") || candidate.startsWith("127.0.0.1")) {
      candidate = `http://${candidate}`;
    } else {
      throw new InvalidApiUrlConfigurationError(
        "Base URL must include an explicit http or https protocol.",
      );
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidApiUrlConfigurationError("Base URL is malformed and could not be parsed.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidApiUrlConfigurationError(
      `Unsupported protocol '${parsed.protocol}'. Base URL must use http: or https:.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new InvalidApiUrlConfigurationError(
      "Base URL must not contain user credentials.",
    );
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    throw new InvalidApiUrlConfigurationError("Base URL must have a valid hostname.");
  }

  return parsed;
}

/**
 * Resolves an API path against the configured deployment origin or relative strategy.
 *
 * Rules:
 * 1. If strategy is 'relative' or no base URL is configured, returns root-relative path.
 * 2. If a base URL is configured, validates that it uses http/https without credentials.
 * 3. Deduplicates common path prefixes between base URL pathname and target path (e.g. /api).
 * 4. Normalizes slashes so no double slashes or missing slashes occur.
 * 5. Preserves query parameters and hashes.
 */
export function resolveApiUrl(path: string, config?: ApiUrlResolutionConfig): string {
  const normalizedPath = normalizePath(path);

  if (config?.strategy === "relative") {
    return normalizedPath;
  }

  const rawBase = extractRawBaseUrl(config);
  if (!rawBase) {
    return normalizedPath;
  }

  const parsedBase = parseAndValidateBaseUrl(rawBase);

  // Extract base pathname (excluding trailing slashes)
  const basePathname = parsedBase.pathname.replace(/\/+$/, "");

  // Separate path from query string and hash
  const queryIndex = normalizedPath.indexOf("?");
  const hashIndex = normalizedPath.indexOf("#");
  const splitIndex =
    queryIndex >= 0 && hashIndex >= 0
      ? Math.min(queryIndex, hashIndex)
      : queryIndex >= 0
        ? queryIndex
        : hashIndex >= 0
          ? hashIndex
          : normalizedPath.length;

  const targetPathOnly = normalizedPath.slice(0, splitIndex);
  const targetSuffix = normalizedPath.slice(splitIndex);

  let mergedPath: string;

  if (basePathname.length === 0 || basePathname === "/") {
    mergedPath = targetPathOnly;
  } else if (targetPathOnly === basePathname) {
    mergedPath = basePathname;
  } else if (targetPathOnly.startsWith(basePathname + "/")) {
    // Prefix deduplication: base ends with /api and target starts with /api/...
    mergedPath = targetPathOnly;
  } else {
    // If base pathname is e.g. /v1 and target is /api/rates
    // Check if target starts with the last segment of basePathname
    const lastBaseSegment = basePathname.split("/").filter(Boolean).at(-1);
    const firstTargetSegment = targetPathOnly.split("/").filter(Boolean).at(0);

    if (lastBaseSegment && firstTargetSegment && lastBaseSegment === firstTargetSegment) {
      // Deduplicate overlapping boundary segment, e.g. /v1/api + /api/rates
      const remainingTarget = targetPathOnly.slice(firstTargetSegment.length + 1);
      mergedPath = `${basePathname}${remainingTarget.startsWith("/") ? remainingTarget : `/${remainingTarget}`}`;
    } else {
      mergedPath = `${basePathname}${targetPathOnly}`;
    }
  }

  // Ensure clean single slashes
  const cleanMergedPath = mergedPath.replace(/\/+/g, "/");

  return `${parsedBase.origin}${cleanMergedPath}${targetSuffix}`;
}

/**
 * Executes a fetch request for dashboard API endpoints using the resolved base URL.
 */
export async function fetchDashboardApi(
  path: string,
  init?: RequestInit,
  config?: ApiUrlResolutionConfig,
): Promise<Response> {
  const url = resolveApiUrl(path, config);
  return fetch(url, init);
}
