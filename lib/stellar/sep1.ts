import { SEPS, type StellarSep } from "@/constants/seps";
import { transferCapable } from "@/lib/stellar/anchors";
import { isValidHomeDomain } from "@/lib/stellar/anchorRegistry";
import type {
  AnchorRegistryEntry,
  DiscoveredAnchor,
  DiscoveredAnchorAsset,
  DiscoveredAnchorEndpoints,
  Sep1Data,
} from "@/types/anchor";
import { parse } from "smol-toml";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOML_BYTES = 100_000;
const SUPPORTED_SEPS = new Set<number>(Object.values(SEPS));

export type Sep1ErrorCode =
  | "INVALID_HOME_DOMAIN"
  | "TIMEOUT"
  | "NETWORK_FAILURE"
  | "HTTP_FAILURE"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_TOML"
  | "INVALID_DATA"
  | "MISSING_REQUIRED_DATA";

export class Sep1DiscoveryError extends Error {
  readonly code: Sep1ErrorCode;
  readonly tomlUrl: string;
  readonly status?: number;

  constructor(
    code: Sep1ErrorCode,
    message: string,
    tomlUrl: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "Sep1DiscoveryError";
    this.code = code;
    this.tomlUrl = tomlUrl;
    this.status = options?.status;
  }
}

export type FetchSep1Options = Readonly<{
  timeoutMs?: number;
  fetcher?: typeof fetch;
}>;

export function buildSep1TomlUrl(homeDomain: string): string {
  if (!isValidHomeDomain(homeDomain)) {
    throw new Sep1DiscoveryError(
      "INVALID_HOME_DOMAIN",
      `Invalid anchor home domain: "${homeDomain}"`,
      homeDomain,
    );
  }

  return `https://${homeDomain}/.well-known/stellar.toml`;
}

export function normalizeSeps(seps: Iterable<number>): readonly StellarSep[] {
  const normalized = new Set<StellarSep>();

  for (const sep of seps) {
    if (SUPPORTED_SEPS.has(sep)) {
      normalized.add(sep as StellarSep);
    }
  }

  return Object.freeze([...normalized].sort((left, right) => left - right));
}

export function detectSupportedSeps(
  endpoints: DiscoveredAnchorEndpoints,
): readonly StellarSep[] {
  const detected: number[] = [SEPS.SEP_1];

  if (endpoints.transferServer) detected.push(SEPS.SEP_6);
  if (endpoints.webAuthEndpoint) detected.push(SEPS.SEP_10);
  if (endpoints.transferServerSep24) detected.push(SEPS.SEP_24);
  if (endpoints.directPaymentServer) detected.push(SEPS.SEP_31);
  if (endpoints.anchorQuoteServer) detected.push(SEPS.SEP_38);

  return normalizeSeps(detected);
}

export function parseSep1Toml(
  source: string,
  tomlUrl = "stellar.toml",
): Sep1Data {
  let document: unknown;

  try {
    document = parse(source);
  } catch {
    throw new Sep1DiscoveryError(
      "INVALID_TOML",
      `Invalid SEP-1 TOML at ${tomlUrl}`,
      tomlUrl,
    );
  }

  if (!isRecord(document)) {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      `SEP-1 document at ${tomlUrl} is not a TOML table`,
      tomlUrl,
    );
  }

  const networkPassphrase = requireString(
    document,
    "NETWORK_PASSPHRASE",
    tomlUrl,
  );
  const documentation = requireRecord(document, "DOCUMENTATION", tomlUrl);
  const organizationName = requireString(
    documentation,
    "ORG_NAME",
    tomlUrl,
  );
  const organizationUrl = optionalHttpsUrl(
    documentation,
    "ORG_URL",
    tomlUrl,
  );
  const endpoints = parseEndpoints(document, tomlUrl);
  const assets = parseAssets(document.CURRENCIES, tomlUrl);
  const seps = detectSupportedSeps(endpoints);

  return Object.freeze({
    organizationName,
    ...(organizationUrl ? { organizationUrl } : {}),
    networkPassphrase,
    seps,
    endpoints,
    assets,
  });
}

export async function fetchSep1Toml(
  homeDomain: string,
  options: FetchSep1Options = {},
): Promise<Readonly<{ tomlUrl: string; data: Sep1Data }>> {
  const tomlUrl = buildSep1TomlUrl(homeDomain);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      "SEP-1 timeout must be a positive finite number",
      tomlUrl,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(tomlUrl, {
      headers: { Accept: "text/plain, application/toml;q=0.9, */*;q=0.1" },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Sep1DiscoveryError(
        "HTTP_FAILURE",
        `SEP-1 request returned HTTP ${response.status}: ${tomlUrl}`,
        tomlUrl,
        { status: response.status },
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));

    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOML_BYTES) {
      throw responseTooLargeError(tomlUrl);
    }

    const source = await readBoundedBody(response, tomlUrl);

    return Object.freeze({ tomlUrl, data: parseSep1Toml(source, tomlUrl) });
  } catch (cause) {
    if (cause instanceof Sep1DiscoveryError) throw cause;

    if (controller.signal.aborted) {
      throw new Sep1DiscoveryError(
        "TIMEOUT",
        `SEP-1 request timed out after ${timeoutMs}ms: ${tomlUrl}`,
        tomlUrl,
        { cause },
      );
    }

    throw new Sep1DiscoveryError(
      "NETWORK_FAILURE",
      `SEP-1 network request failed: ${tomlUrl}`,
      tomlUrl,
      { cause },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverAnchor(
  entry: AnchorRegistryEntry,
  options: FetchSep1Options = {},
): Promise<DiscoveredAnchor> {
  const { tomlUrl, data } = await fetchSep1Toml(entry.homeDomain, options);

  return Object.freeze({
    ...entry,
    tomlUrl,
    organizationName: data.organizationName,
    ...(data.organizationUrl ? { organizationUrl: data.organizationUrl } : {}),
    networkPassphrase: data.networkPassphrase,
    seps: data.seps,
    isTransferCapable: transferCapable(data.seps),
    endpoints: data.endpoints,
    assets: data.assets,
  });
}

function parseEndpoints(
  document: Record<string, unknown>,
  tomlUrl: string,
): DiscoveredAnchorEndpoints {
  const transferServer = optionalHttpsUrl(
    document,
    "TRANSFER_SERVER",
    tomlUrl,
  );
  const transferServerSep24 = optionalHttpsUrl(
    document,
    "TRANSFER_SERVER_SEP0024",
    tomlUrl,
  );
  const webAuthEndpoint = optionalHttpsUrl(
    document,
    "WEB_AUTH_ENDPOINT",
    tomlUrl,
  );
  const kycServer = optionalHttpsUrl(document, "KYC_SERVER", tomlUrl);
  const directPaymentServer = optionalHttpsUrl(
    document,
    "DIRECT_PAYMENT_SERVER",
    tomlUrl,
  );
  const anchorQuoteServer = optionalHttpsUrl(
    document,
    "ANCHOR_QUOTE_SERVER",
    tomlUrl,
  );

  return Object.freeze({
    ...(transferServer ? { transferServer } : {}),
    ...(transferServerSep24 ? { transferServerSep24 } : {}),
    ...(webAuthEndpoint ? { webAuthEndpoint } : {}),
    ...(kycServer ? { kycServer } : {}),
    ...(directPaymentServer ? { directPaymentServer } : {}),
    ...(anchorQuoteServer ? { anchorQuoteServer } : {}),
  });
}

function parseAssets(
  value: unknown,
  tomlUrl: string,
): readonly DiscoveredAnchorAsset[] {
  if (value === undefined) return Object.freeze([]);

  if (!Array.isArray(value)) {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      `CURRENCIES must be an array of TOML tables: ${tomlUrl}`,
      tomlUrl,
    );
  }

  const assets = value.map((currency, index) => {
    if (!isRecord(currency)) {
      throw new Sep1DiscoveryError(
        "INVALID_DATA",
        `CURRENCIES[${index}] must be a TOML table: ${tomlUrl}`,
        tomlUrl,
      );
    }

    const code = requireString(currency, "code", tomlUrl);
    const issuer = optionalString(currency, "issuer", tomlUrl);
    const status = optionalString(currency, "status", tomlUrl);
    const isAssetAnchored = optionalBoolean(
      currency,
      "is_asset_anchored",
      tomlUrl,
    );
    const anchorAssetType = optionalString(
      currency,
      "anchor_asset_type",
      tomlUrl,
    );
    const anchorAsset = optionalString(currency, "anchor_asset", tomlUrl);

    return Object.freeze({
      code,
      ...(issuer ? { issuer } : {}),
      ...(status ? { status } : {}),
      ...(isAssetAnchored !== undefined ? { isAssetAnchored } : {}),
      ...(anchorAssetType ? { anchorAssetType } : {}),
      ...(anchorAsset ? { anchorAsset } : {}),
    });
  });

  return Object.freeze(assets);
}

function requireRecord(
  record: Record<string, unknown>,
  key: string,
  tomlUrl: string,
): Record<string, unknown> {
  const value = record[key];

  if (!isRecord(value)) {
    throw new Sep1DiscoveryError(
      "MISSING_REQUIRED_DATA",
      `Missing required SEP-1 table ${key}: ${tomlUrl}`,
      tomlUrl,
    );
  }

  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  tomlUrl: string,
): string {
  const value = record[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new Sep1DiscoveryError(
      "MISSING_REQUIRED_DATA",
      `Missing required SEP-1 string ${key}: ${tomlUrl}`,
      tomlUrl,
    );
  }

  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  tomlUrl: string,
): string | undefined {
  const value = record[key];

  if (value === undefined) return undefined;

  if (typeof value !== "string" || !value.trim()) {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      `SEP-1 field ${key} must be a non-empty string: ${tomlUrl}`,
      tomlUrl,
    );
  }

  return value.trim();
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  tomlUrl: string,
): boolean | undefined {
  const value = record[key];

  if (value === undefined) return undefined;

  if (typeof value !== "boolean") {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      `SEP-1 field ${key} must be a boolean: ${tomlUrl}`,
      tomlUrl,
    );
  }

  return value;
}

function optionalHttpsUrl(
  record: Record<string, unknown>,
  key: string,
  tomlUrl: string,
): string | undefined {
  const value = optionalString(record, key, tomlUrl);

  if (!value) return undefined;

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") throw new Error("URL must use HTTPS");

    return url.toString();
  } catch {
    throw new Sep1DiscoveryError(
      "INVALID_DATA",
      `SEP-1 field ${key} must be a valid HTTPS URL: ${tomlUrl}`,
      tomlUrl,
    );
  }
}

async function readBoundedBody(
  response: Response,
  tomlUrl: string,
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

      if (bytesRead > MAX_TOML_BYTES) {
        await reader.cancel();
        throw responseTooLargeError(tomlUrl);
      }

      source += decoder.decode(value, { stream: true });
    }

    return source + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseTooLargeError(tomlUrl: string): Sep1DiscoveryError {
  return new Sep1DiscoveryError(
    "RESPONSE_TOO_LARGE",
    `SEP-1 response exceeds ${MAX_TOML_BYTES} bytes: ${tomlUrl}`,
    tomlUrl,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
