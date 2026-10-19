/**
 * Normalized rate-source provenance contract and validation helpers (#332, #333).
 *
 * Defines the authoritative, non-secret fields used to trace a normalized
 * rate observation back to its capture run, reviewed configuration, and endpoint
 * without storing credentials, tokens, or raw remote payloads.
 */

/**
 * Permitted provenance fields for a normalized rate observation.
 */
export type NormalizedRateSourceProvenance = Readonly<{
  sourceType: "sep38";
  anchorSlug: string;
  corridorSlug: string;
  endpointUrl: string;
  configurationDigest: string;
  requestShapeVersion: string;
  capturedAt: string; // ISO 8601 string
  captureRunId?: string;
}>;

/**
 * Result of validating and redacting/normalizing rate-source provenance fields.
 */
export type RateSourceProvenanceValidationResult =
  | Readonly<{ ok: true; provenance: NormalizedRateSourceProvenance }>
  | Readonly<{ ok: false; code: RateSourceProvenanceErrorCode }>;

export type RateSourceProvenanceErrorCode =
  | "PROVENANCE_REQUIRED"
  | "INVALID_SOURCE_TYPE"
  | "INVALID_ANCHOR_SLUG"
  | "INVALID_CORRIDOR_SLUG"
  | "INVALID_ENDPOINT_URL"
  | "CREDENTIAL_BEARING_URL"
  | "PROHIBITED_SENSITIVE_FIELD"
  | "INVALID_CONFIGURATION_DIGEST"
  | "INVALID_REQUEST_SHAPE_VERSION"
  | "INVALID_CAPTURED_AT"
  | "INVALID_CAPTURE_RUN_ID";

export class RateSourceProvenanceError extends Error {
  readonly code: RateSourceProvenanceErrorCode;

  constructor(code: RateSourceProvenanceErrorCode) {
    super(code);
    this.name = "RateSourceProvenanceError";
    this.code = code;
  }
}

/**
 * Prohibited secret keys. If any object in provenance contains these keys
 * (case-insensitive, normalized for dashes/underscores), it is rejected.
 */
const PROHIBITED_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "client_secret",
  "token",
  "access_token",
  "refresh_token",
  "auth",
  "authorization",
  "api_key",
  "apikey",
  "private_key",
  "signing_key",
  "key",
  "cookie",
  "session",
  "session_token",
  "bearer",
  "credential",
  "credentials",
]);

const PROHIBITED_VALUE_PATTERNS = [
  /^(?:postgres(?:ql)?|mysql|redis|mongodb):\/\/[^\s/@:]+:[^\s/@]+@/i,
  /^bearer\s+[a-z0-9._~+\/-]+=*$/i,
  /^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i,
];

const CREDENTIAL_URL_PATTERN =
  /^(?:https?):\/\/[^\s/@:]+:[^\s/@]+@/i;

const SENSITIVE_QUERY_PARAM_PATTERN =
  /[?&](?:token|access_token|key|api_key|apikey|secret|password|auth|authorization|signature|sig)=/i;

/**
 * Sanitizes or validates an endpoint URL.
 * - Rejects URLs containing basic auth user:pass
 * - Rejects URLs with sensitive query parameters (e.g. token=..., key=..., secret=...)
 * - Safely strips trailing slashes and ensures valid URL syntax
 * - Returns clean URL string without revealing any sensitive components
 */
export function sanitizeEndpointUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new RateSourceProvenanceError("INVALID_ENDPOINT_URL");
  }

  const trimmed = rawUrl.trim();

  if (CREDENTIAL_URL_PATTERN.test(trimmed)) {
    throw new RateSourceProvenanceError("CREDENTIAL_BEARING_URL");
  }

  if (SENSITIVE_QUERY_PARAM_PATTERN.test(trimmed)) {
    throw new RateSourceProvenanceError("CREDENTIAL_BEARING_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RateSourceProvenanceError("INVALID_ENDPOINT_URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RateSourceProvenanceError("INVALID_ENDPOINT_URL");
  }

  if (parsed.username || parsed.password) {
    throw new RateSourceProvenanceError("CREDENTIAL_BEARING_URL");
  }

  // Check search params individually for sensitive parameter keys
  for (const paramKey of parsed.searchParams.keys()) {
    const normalizedKey = paramKey.toLowerCase().replaceAll("-", "_");
    if (PROHIBITED_KEYS.has(normalizedKey)) {
      throw new RateSourceProvenanceError("CREDENTIAL_BEARING_URL");
    }
  }

  return parsed.toString();
}

/**
 * Scans an input object recursively for sensitive keys and sensitive string patterns.
 * Never throws with or logs the secret value; only throws a deterministic error code.
 */
export function assertNoSensitiveFields(value: unknown, path = "root"): void {
  if (typeof value === "string") {
    for (const pattern of PROHIBITED_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new RateSourceProvenanceError("PROHIBITED_SENSITIVE_FIELD");
      }
    }
    return;
  }

  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveFields(item, path);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      if (PROHIBITED_KEYS.has(normalizedKey)) {
        throw new RateSourceProvenanceError("PROHIBITED_SENSITIVE_FIELD");
      }
      assertNoSensitiveFields(val, `${path}.${key}`);
    }
  }
}

/**
 * Validates and normalizes rate-source provenance fields.
 * Deterministic behavior that guarantees no secret leaks in errors.
 */
export function validateRateSourceProvenance(
  input: unknown,
): RateSourceProvenanceValidationResult {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new RateSourceProvenanceError("PROVENANCE_REQUIRED");
    }

    const record = input as Record<string, unknown>;

    // Step 1: Validate and sanitize endpointUrl first if present so credential-bearing URLs are classified correctly
    let cleanEndpointUrl = "";
    if ("endpointUrl" in record) {
      if (typeof record.endpointUrl !== "string") {
        throw new RateSourceProvenanceError("INVALID_ENDPOINT_URL");
      }
      cleanEndpointUrl = sanitizeEndpointUrl(record.endpointUrl);
    } else {
      throw new RateSourceProvenanceError("INVALID_ENDPOINT_URL");
    }

    // Step 2: Scan entire structure for prohibited sensitive fields
    assertNoSensitiveFields(input);

    // Step 3: Validate sourceType
    if (record.sourceType !== "sep38") {
      throw new RateSourceProvenanceError("INVALID_SOURCE_TYPE");
    }

    // Step 4: Validate anchorSlug
    if (
      typeof record.anchorSlug !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.anchorSlug) ||
      record.anchorSlug.length > 120
    ) {
      throw new RateSourceProvenanceError("INVALID_ANCHOR_SLUG");
    }

    // Step 5: Validate corridorSlug
    if (
      typeof record.corridorSlug !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.corridorSlug) ||
      record.corridorSlug.length > 120
    ) {
      throw new RateSourceProvenanceError("INVALID_CORRIDOR_SLUG");
    }

    // Step 6: Validate configurationDigest
    if (
      typeof record.configurationDigest !== "string" ||
      !/^[0-9a-f]{64}$/i.test(record.configurationDigest.trim())
    ) {
      throw new RateSourceProvenanceError("INVALID_CONFIGURATION_DIGEST");
    }
    const cleanConfigurationDigest = record.configurationDigest.trim().toLowerCase();

    // Step 7: Validate requestShapeVersion
    if (
      typeof record.requestShapeVersion !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(record.requestShapeVersion.trim())
    ) {
      throw new RateSourceProvenanceError("INVALID_REQUEST_SHAPE_VERSION");
    }
    const cleanRequestShapeVersion = record.requestShapeVersion.trim();

    // Step 8: Validate capturedAt
    let cleanCapturedAt: string;
    if (record.capturedAt instanceof Date) {
      if (Number.isNaN(record.capturedAt.getTime())) {
        throw new RateSourceProvenanceError("INVALID_CAPTURED_AT");
      }
      cleanCapturedAt = record.capturedAt.toISOString();
    } else if (typeof record.capturedAt === "string") {
      const parsed = new Date(record.capturedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new RateSourceProvenanceError("INVALID_CAPTURED_AT");
      }
      cleanCapturedAt = parsed.toISOString();
    } else {
      throw new RateSourceProvenanceError("INVALID_CAPTURED_AT");
    }

    // Step 9: Validate optional captureRunId
    let cleanCaptureRunId: string | undefined;
    if (record.captureRunId !== undefined && record.captureRunId !== null) {
      if (
        typeof record.captureRunId !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(record.captureRunId.trim())
      ) {
        throw new RateSourceProvenanceError("INVALID_CAPTURE_RUN_ID");
      }
      cleanCaptureRunId = record.captureRunId.trim();
    }

    const provenance: NormalizedRateSourceProvenance = Object.freeze({
      sourceType: "sep38",
      anchorSlug: record.anchorSlug,
      corridorSlug: record.corridorSlug,
      endpointUrl: cleanEndpointUrl,
      configurationDigest: cleanConfigurationDigest,
      requestShapeVersion: cleanRequestShapeVersion,
      capturedAt: cleanCapturedAt,
      ...(cleanCaptureRunId ? { captureRunId: cleanCaptureRunId } : {}),
    });

    return Object.freeze({ ok: true, provenance });
  } catch (error) {
    if (error instanceof RateSourceProvenanceError) {
      return Object.freeze({ ok: false, code: error.code });
    }
    return Object.freeze({ ok: false, code: "PROVENANCE_REQUIRED" });
  }
}
