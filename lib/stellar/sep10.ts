import { StrKey, WebAuth } from "@stellar/stellar-sdk";

import { parseStellarAuthToken } from "@/lib/stellar/auth";
import { isValidHomeDomain } from "@/lib/stellar/anchorRegistry";
import type {
  Sep10ChallengeSigner,
  StellarAuthProvider,
  StellarAuthToken,
} from "@/types/stellarAuth";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 100_000;
const MAX_XDR_BYTES = 100_000;
const UINT64_MAX = "18446744073709551615";
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/;

type Sep10ChallengeOperation = Readonly<{
  type: string;
  name?: string;
  source?: string;
  value?: Uint8Array | null;
}>;

export type Sep10AuthErrorCode =
  | "INVALID_ENDPOINT"
  | "INVALID_CONFIGURATION"
  | "TIMEOUT"
  | "NETWORK_FAILURE"
  | "REDIRECT"
  | "HTTP_FAILURE"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_JSON"
  | "INVALID_CHALLENGE"
  | "SIGNING_FAILURE";

export class Sep10AuthError extends Error {
  readonly code: Sep10AuthErrorCode;
  readonly endpoint: string;
  readonly status?: number;

  constructor(
    code: Sep10AuthErrorCode,
    message: string,
    endpoint: string,
    options: Readonly<{ status?: number }> = {},
  ) {
    super(message);
    this.name = "Sep10AuthError";
    this.code = code;
    this.endpoint = endpoint;
    this.status = options.status;
  }
}

export type Sep10AuthConfig = Readonly<{
  homeDomain: string;
  webAuthEndpoint: string;
  serverSigningKey: string;
  networkPassphrase: string;
  account: string;
  memo?: string;
  clientDomain?: string;
  clientDomainSigningKey?: string;
}>;

export type Sep10AuthDependencies = Readonly<{
  signer: Sep10ChallengeSigner;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}>;

export type Sep10Challenge = Readonly<{
  transaction: string;
  networkPassphrase: string;
}>;

export function createSep10AuthProvider(
  config: Sep10AuthConfig,
  dependencies: Sep10AuthDependencies,
): StellarAuthProvider {
  const normalized = normalizeConfig(config);
  validateDependencies(dependencies, normalized.webAuthEndpoint);

  return Object.freeze({
    getToken: () => requestSep10Token(normalized, dependencies),
  });
}

export async function requestSep10Token(
  config: Sep10AuthConfig,
  dependencies: Sep10AuthDependencies,
): Promise<StellarAuthToken> {
  const normalized = normalizeConfig(config);
  validateDependencies(dependencies, normalized.webAuthEndpoint);
  const options = Object.freeze({
    fetcher: dependencies.fetcher ?? fetch,
    timeoutMs: dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  validateTimeout(options.timeoutMs, normalized.webAuthEndpoint);

  const challengeUrl = buildSep10ChallengeUrl(normalized);
  const challengeValue = await requestJson(challengeUrl, {}, options);
  const challenge = parseSep10ChallengeResponse(
    challengeValue,
    normalized.networkPassphrase,
    normalized.webAuthEndpoint,
  );

  validateSep10Challenge(challenge.transaction, normalized);

  let signedTransaction: string;
  try {
    signedTransaction = await dependencies.signer.signChallenge(
      Object.freeze({
        account: normalized.account,
        transaction: challenge.transaction,
        networkPassphrase: challenge.networkPassphrase,
        ...(normalized.clientDomain
          ? {
              clientDomain: normalized.clientDomain,
              clientDomainSigningKey: normalized.clientDomainSigningKey,
            }
          : {}),
      }),
    );
  } catch {
    throw signingFailure(normalized.webAuthEndpoint);
  }

  validateSignedChallenge(signedTransaction, normalized);

  const tokenResponse = await requestJson(
    normalized.webAuthEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signedTransaction }),
    },
    options,
  );
  const rawToken = parseTokenResponse(tokenResponse, normalized.webAuthEndpoint);

  return parseStellarAuthToken(
    rawToken,
    {
      protocol: "sep10",
      homeDomain: normalized.homeDomain,
      expectedSubject: expectedSubject(normalized),
    },
    { now: dependencies.now?.() },
  );
}

export function normalizeSep10AuthEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      !isValidHomeDomain(url.hostname)
    ) {
      throw new Error("invalid endpoint");
    }

    return url.toString();
  } catch {
    throw new Sep10AuthError(
      "INVALID_ENDPOINT",
      "SEP-10 web authentication endpoint must be a public HTTPS URL",
      safeEndpoint(endpoint),
    );
  }
}

export function buildSep10ChallengeUrl(config: Sep10AuthConfig): string {
  const normalized = normalizeConfig(config);
  const url = new URL(normalized.webAuthEndpoint);
  url.searchParams.set("account", normalized.account);
  url.searchParams.set("home_domain", normalized.homeDomain);
  if (normalized.memo) url.searchParams.set("memo", normalized.memo);
  if (normalized.clientDomain) {
    url.searchParams.set("client_domain", normalized.clientDomain);
  }
  return url.toString();
}

export function parseSep10ChallengeResponse(
  value: unknown,
  expectedNetworkPassphrase: string,
  endpoint = "SEP-10 web authentication endpoint",
): Sep10Challenge {
  const record = requireRecord(value, endpoint, "INVALID_CHALLENGE");
  const transaction = requireSafeString(
    record.transaction,
    endpoint,
    "INVALID_CHALLENGE",
    MAX_XDR_BYTES,
  );
  const receivedPassphrase = record.network_passphrase;

  if (
    receivedPassphrase !== undefined &&
    (typeof receivedPassphrase !== "string" ||
      receivedPassphrase !== expectedNetworkPassphrase)
  ) {
    throw invalidChallenge(endpoint);
  }

  return Object.freeze({
    transaction,
    networkPassphrase: expectedNetworkPassphrase,
  });
}

function normalizeConfig(config: Sep10AuthConfig): Sep10AuthConfig {
  const endpoint = normalizeSep10AuthEndpoint(config.webAuthEndpoint);

  if (!isValidHomeDomain(config.homeDomain)) {
    throw invalidConfiguration(endpoint);
  }
  if (!StrKey.isValidEd25519PublicKey(config.serverSigningKey)) {
    throw invalidConfiguration(endpoint);
  }
  if (
    !StrKey.isValidEd25519PublicKey(config.account) &&
    !StrKey.isValidMed25519PublicKey(config.account)
  ) {
    throw invalidConfiguration(endpoint);
  }

  const networkPassphrase = validateConfigurationText(
    config.networkPassphrase,
    endpoint,
  );
  const memo = validateMemo(config.memo, config.account, endpoint);
  const clientDomain = config.clientDomain;
  const clientDomainSigningKey = config.clientDomainSigningKey;
  if (
    (clientDomain !== undefined && !isValidHomeDomain(clientDomain)) ||
    (clientDomain === undefined) !== (clientDomainSigningKey === undefined) ||
    (clientDomainSigningKey !== undefined &&
      !StrKey.isValidEd25519PublicKey(clientDomainSigningKey))
  ) {
    throw invalidConfiguration(endpoint);
  }

  return Object.freeze({
    homeDomain: config.homeDomain,
    webAuthEndpoint: endpoint,
    serverSigningKey: config.serverSigningKey,
    networkPassphrase,
    account: config.account,
    ...(memo ? { memo } : {}),
    ...(clientDomain ? { clientDomain } : {}),
    ...(clientDomainSigningKey ? { clientDomainSigningKey } : {}),
  });
}

function validateSep10Challenge(
  transaction: string,
  config: Sep10AuthConfig,
): void {
  try {
    const webAuthDomain = new URL(config.webAuthEndpoint).hostname;
    const parsed = WebAuth.readChallengeTx(
      transaction,
      config.serverSigningKey,
      config.networkPassphrase,
      config.homeDomain,
      webAuthDomain,
    );

    if (
      parsed.clientAccountID !== config.account ||
      parsed.matchedHomeDomain !== config.homeDomain ||
      parsed.memo !== (config.memo ?? null) ||
      !matchesWebAuthDomainOperation(parsed.tx.operations, config) ||
      !matchesClientDomainOperation(parsed.tx.operations, config)
    ) {
      throw new Error("challenge identity mismatch");
    }
  } catch {
    throw invalidChallenge(config.webAuthEndpoint);
  }
}

function matchesWebAuthDomainOperation(
  operations: readonly Sep10ChallengeOperation[],
  config: Sep10AuthConfig,
): boolean {
  const expectedDomain = new URL(config.webAuthEndpoint).hostname;
  const webAuthDomainOperations = operations.filter(
    (operation) =>
      operation.type === "manageData" && operation.name === "web_auth_domain",
  );

  if (webAuthDomainOperations.length !== 1) return false;

  const operation = webAuthDomainOperations[0];
  return (
    operation?.source === config.serverSigningKey &&
    operation.value !== null &&
    operation.value !== undefined &&
    new TextDecoder().decode(operation.value) === expectedDomain
  );
}

function matchesClientDomainOperation(
  operations: readonly Sep10ChallengeOperation[],
  config: Sep10AuthConfig,
): boolean {
  const clientDomainOperations = operations.filter(
    (operation) =>
      operation.type === "manageData" && operation.name === "client_domain",
  );

  if (!config.clientDomain) return clientDomainOperations.length === 0;
  if (clientDomainOperations.length !== 1) return false;

  const operation = clientDomainOperations[0];
  return (
    operation?.source === config.clientDomainSigningKey &&
    operation.value !== null &&
    operation.value !== undefined &&
    new TextDecoder().decode(operation.value) === config.clientDomain
  );
}

function validateSignedChallenge(
  transaction: string,
  config: Sep10AuthConfig,
): void {
  try {
    requireSafeString(
      transaction,
      config.webAuthEndpoint,
      "SIGNING_FAILURE",
      MAX_XDR_BYTES,
    );
    validateSep10Challenge(transaction, config);
  } catch {
    throw signingFailure(config.webAuthEndpoint);
  }
}

function parseTokenResponse(value: unknown, endpoint: string): string {
  const record = requireRecord(value, endpoint, "INVALID_CHALLENGE");
  return requireSafeString(
    record.token,
    endpoint,
    "INVALID_CHALLENGE",
    16_384,
  );
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: Readonly<{ fetcher: typeof fetch; timeoutMs: number }>,
): Promise<unknown> {
  const endpoint = safeEndpoint(url);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetcher(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Sep10AuthError(
        "REDIRECT",
        "SEP-10 redirects are not allowed",
        endpoint,
        { status: response.status },
      );
    }
    if (response.status !== 200) {
      throw new Sep10AuthError(
        "HTTP_FAILURE",
        `SEP-10 request returned HTTP ${response.status}`,
        endpoint,
        { status: response.status },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new Sep10AuthError(
        "INVALID_CONTENT_TYPE",
        "SEP-10 response must use application/json",
        endpoint,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
      throw responseTooLarge(endpoint);
    }

    const source = await readBoundedBody(response, endpoint);
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new Sep10AuthError(
        "INVALID_JSON",
        "SEP-10 response is not valid JSON",
        endpoint,
      );
    }
  } catch (error) {
    if (error instanceof Sep10AuthError) throw error;
    if (controller.signal.aborted) {
      throw new Sep10AuthError(
        "TIMEOUT",
        `SEP-10 request timed out after ${options.timeoutMs}ms`,
        endpoint,
      );
    }
    throw new Sep10AuthError(
      "NETWORK_FAILURE",
      "SEP-10 network request failed",
      endpoint,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(
  response: Response,
  endpoint: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let source = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_JSON_BYTES) {
        await reader.cancel();
        throw responseTooLarge(endpoint);
      }
      source += decoder.decode(value, { stream: true });
    }
    return source + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function requireRecord(
  value: unknown,
  endpoint: string,
  code: "INVALID_CHALLENGE" | "SIGNING_FAILURE",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw code === "SIGNING_FAILURE"
      ? signingFailure(endpoint)
      : invalidChallenge(endpoint);
  }
  return value as Record<string, unknown>;
}

function requireSafeString(
  value: unknown,
  endpoint: string,
  code: "INVALID_CHALLENGE" | "SIGNING_FAILURE",
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    UNSAFE_TEXT.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw code === "SIGNING_FAILURE"
      ? signingFailure(endpoint)
      : invalidChallenge(endpoint);
  }
  return value;
}

function validateDependencies(
  dependencies: Sep10AuthDependencies,
  endpoint: string,
): void {
  if (!dependencies?.signer?.signChallenge) {
    throw invalidConfiguration(endpoint);
  }
  if (dependencies.now !== undefined && typeof dependencies.now !== "function") {
    throw invalidConfiguration(endpoint);
  }
}

function validateTimeout(timeoutMs: number, endpoint: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw invalidConfiguration(endpoint);
  }
}

function validateConfigurationText(value: string, endpoint: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    UNSAFE_TEXT.test(value) ||
    value.length > 256
  ) {
    throw invalidConfiguration(endpoint);
  }
  return value;
}

function validateMemo(
  value: string | undefined,
  account: string,
  endpoint: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    !StrKey.isValidEd25519PublicKey(account) ||
    !/^(?:0|[1-9]\d*)$/.test(value)
  ) {
    throw invalidConfiguration(endpoint);
  }

  if (
    value.length > UINT64_MAX.length ||
    (value.length === UINT64_MAX.length && value > UINT64_MAX)
  ) {
    throw invalidConfiguration(endpoint);
  }

  return value;
}

function expectedSubject(config: Sep10AuthConfig): string {
  return config.memo ? `${config.account}:${config.memo}` : config.account;
}

function responseTooLarge(endpoint: string): Sep10AuthError {
  return new Sep10AuthError(
    "RESPONSE_TOO_LARGE",
    `SEP-10 response exceeds ${MAX_JSON_BYTES} bytes`,
    endpoint,
  );
}

function invalidConfiguration(endpoint: string): Sep10AuthError {
  return new Sep10AuthError(
    "INVALID_CONFIGURATION",
    "Invalid SEP-10 authentication configuration",
    safeEndpoint(endpoint),
  );
}

function invalidChallenge(endpoint: string): Sep10AuthError {
  return new Sep10AuthError(
    "INVALID_CHALLENGE",
    "Invalid SEP-10 challenge or token response",
    safeEndpoint(endpoint),
  );
}

function signingFailure(endpoint: string): Sep10AuthError {
  return new Sep10AuthError(
    "SIGNING_FAILURE",
    "SEP-10 challenge signing failed",
    safeEndpoint(endpoint),
  );
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "SEP-10 web authentication endpoint";
  }
}
