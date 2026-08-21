import { isValidHomeDomain } from "@/lib/stellar/anchorRegistry";
import type {
  StellarAuthProvider,
  StellarAuthToken,
  StellarAuthTokenMetadata,
  StellarAuthProtocol,
} from "@/types/stellarAuth";

const MAX_TOKEN_BYTES = 16_384;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const TOKEN_WHITESPACE_OR_CONTROL = /[\u0000-\u0020\u007f]/;

export type StellarAuthErrorCode =
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "PROVIDER_FAILURE";

export class StellarAuthError extends Error {
  readonly code: StellarAuthErrorCode;

  constructor(code: StellarAuthErrorCode, message: string) {
    super(message);
    this.name = "StellarAuthError";
    this.code = code;
  }
}

export async function acquireStellarAuthToken(
  provider: StellarAuthProvider,
  options: Readonly<{ now?: Date }> = {},
): Promise<StellarAuthToken> {
  let token: StellarAuthToken;

  try {
    token = await provider.getToken();
  } catch {
    throw new StellarAuthError(
      "PROVIDER_FAILURE",
      "Stellar authentication provider failed",
    );
  }

  return validateStellarAuthToken(token, options);
}

export function parseStellarAuthToken(
  value: string,
  metadata: StellarAuthTokenMetadata,
  options: Readonly<{ now?: Date }> = {},
): StellarAuthToken {
  validateTokenValue(value);
  validateMetadata(metadata);

  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw invalidToken();
  }

  let payload: unknown;

  try {
    payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw invalidToken();
  }

  if (!isRecord(payload)) throw invalidToken();

  const issuer = requireStringClaim(payload.iss);
  const subject = requireStringClaim(payload.sub);
  const issuedAtSeconds = requireNumericDate(payload.iat);
  const expiresAtSeconds = requireNumericDate(payload.exp);

  if (subject !== metadata.expectedSubject) throw invalidToken();
  validateIssuer(issuer);

  const issuedAt = numericDateToIso(issuedAtSeconds);
  const expiresAt = numericDateToIso(expiresAtSeconds);
  const token = Object.freeze({
    token: value,
    protocol: metadata.protocol,
    homeDomain: metadata.homeDomain,
    issuer,
    subject,
    issuedAt,
    expiresAt,
  });

  return validateStellarAuthToken(token, options);
}

export function validateStellarAuthToken(
  token: StellarAuthToken,
  options: Readonly<{ now?: Date }> = {},
): StellarAuthToken {
  if (!token || typeof token !== "object") throw invalidToken();

  validateTokenValue(token.token);
  validateProtocol(token.protocol);

  if (!isValidHomeDomain(token.homeDomain)) throw invalidToken();
  validateIssuer(token.issuer);

  if (!token.subject || TOKEN_WHITESPACE_OR_CONTROL.test(token.subject)) {
    throw invalidToken();
  }

  const issuedAtMs = parseIsoTimestamp(token.issuedAt);
  const expiresAtMs = parseIsoTimestamp(token.expiresAt);
  const nowMs = (options.now ?? new Date()).getTime();

  if (!Number.isFinite(nowMs)) throw invalidToken();
  if (issuedAtMs >= expiresAtMs || issuedAtMs > nowMs + CLOCK_SKEW_MS) {
    throw invalidToken();
  }
  if (expiresAtMs <= nowMs) {
    throw new StellarAuthError(
      "TOKEN_EXPIRED",
      "Stellar authentication token is expired",
    );
  }

  return Object.isFrozen(token) ? token : Object.freeze({ ...token });
}


function validateMetadata(metadata: StellarAuthTokenMetadata): void {
  validateProtocol(metadata.protocol);
  if (!isValidHomeDomain(metadata.homeDomain)) throw invalidToken();
  if (
    !metadata.expectedSubject ||
    TOKEN_WHITESPACE_OR_CONTROL.test(metadata.expectedSubject)
  ) {
    throw invalidToken();
  }
}

function validateProtocol(protocol: StellarAuthProtocol): void {
  if (protocol !== "sep10" && protocol !== "sep45") throw invalidToken();
}

function validateTokenValue(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    TOKEN_WHITESPACE_OR_CONTROL.test(value)
  ) {
    throw invalidToken();
  }
}

function requireStringClaim(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    TOKEN_WHITESPACE_OR_CONTROL.test(value)
  ) {
    throw invalidToken();
  }
  return value;
}

function requireNumericDate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidToken();
  }
  return value as number;
}

function numericDateToIso(seconds: number): string {
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) throw invalidToken();
  return date.toISOString();
}

function parseIsoTimestamp(value: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw invalidToken();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalidToken();
  return parsed;
}

function validateIssuer(value: string): void {
  try {
    const issuer = new URL(value);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      !isValidHomeDomain(issuer.hostname)
    ) {
      throw new Error("invalid issuer");
    }
  } catch {
    throw invalidToken();
  }
}

function invalidToken(): StellarAuthError {
  return new StellarAuthError(
    "INVALID_TOKEN",
    "Invalid Stellar authentication token",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
