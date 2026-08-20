import { isValidHomeDomain } from "@/lib/stellar/anchorRegistry";
import type {
  ParsedSep38AssetIdentifier,
  Sep38Asset,
  Sep38AssetIdentifier,
  Sep38Authentication,
  Sep38CapabilityDiscovery,
  Sep38DeliveryMethod,
  Sep38Fee,
  Sep38FirmQuote,
  Sep38FirmQuoteRequest,
  Sep38FirmQuoteWireRequest,
  Sep38IndicativePrice,
  Sep38IndicativePriceRequest,
  Sep38Info,
  Sep38Iso4217AssetIdentifier,
  Sep38PairPrice,
  Sep38Prices,
  Sep38PricesRequest,
  Sep38StellarAssetIdentifier,
  Sep38StellarLiquidityPoolAssetIdentifier,
  Sep38SupportedPair,
} from "@/types/sep38";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 100_000;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO4217_PATTERN = /^[A-Z]{3}$/;
const STELLAR_CODE_PATTERN = /^[\x21-\x7e]{1,12}$/;
const STELLAR_ISSUER_PATTERN = /^G[A-Z2-7]{55}$/;
const STELLAR_LIQUIDITY_POOL_PATTERN = /^[0-9a-f]{64}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;

export type Sep38ErrorCode =
  | "INVALID_ASSET"
  | "INVALID_QUOTE_SERVER"
  | "INVALID_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "TIMEOUT"
  | "NETWORK_FAILURE"
  | "REDIRECT"
  | "HTTP_FAILURE"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_JSON"
  | "INVALID_DATA";

export class Sep38ClientError extends Error {
  readonly code: Sep38ErrorCode;
  readonly endpoint: string;
  readonly status?: number;

  constructor(
    code: Sep38ErrorCode,
    message: string,
    endpoint: string,
    options?: Readonly<{ status?: number }>,
  ) {
    super(message);
    this.name = "Sep38ClientError";
    this.code = code;
    this.endpoint = endpoint;
    this.status = options?.status;
  }
}

export type Sep38ClientOptions = Readonly<{
  timeoutMs?: number;
  fetcher?: typeof fetch;
  authentication?: Sep38Authentication;
}>;

export function parseSep38AssetIdentifier(
  value: string,
): ParsedSep38AssetIdentifier {
  if (value.startsWith("iso4217:")) {
    const code = value.slice("iso4217:".length);

    if (!ISO4217_PATTERN.test(code)) {
      throw invalidAsset();
    }

    return Object.freeze({
      scheme: "iso4217",
      code,
      value: value as Sep38Iso4217AssetIdentifier,
    });
  }

  if (value.startsWith("stellar:")) {
    const identifier = value.slice("stellar:".length);

    if (
      identifier === "native" ||
      identifier === "XLM" ||
      identifier === "TestXLM"
    ) {
      return Object.freeze({
        scheme: "stellar",
        code: identifier,
        value: value as Sep38StellarAssetIdentifier,
      });
    }

    const separator = findSep11AssetSeparator(identifier);
    if (separator <= 0) throw invalidAsset();

    const encodedCode = identifier.slice(0, separator);
    const issuer = identifier.slice(separator + 1);
    if (
      issuer === "lp" &&
      STELLAR_LIQUIDITY_POOL_PATTERN.test(encodedCode)
    ) {
      return Object.freeze({
        scheme: "stellar",
        liquidityPoolId: encodedCode,
        value: value as Sep38StellarLiquidityPoolAssetIdentifier,
      });
    }
    const code = decodeSep11AssetCode(encodedCode);

    if (!STELLAR_CODE_PATTERN.test(code) || !isValidStellarIssuer(issuer)) {
      throw invalidAsset();
    }

    return Object.freeze({
      scheme: "stellar",
      code,
      issuer,
      value: value as Sep38StellarAssetIdentifier,
    });
  }

  throw invalidAsset();
}

export function buildIso4217AssetIdentifier(
  code: string,
): Sep38Iso4217AssetIdentifier {
  return parseSep38AssetIdentifier(`iso4217:${code}`)
    .value as Sep38Iso4217AssetIdentifier;
}

export function buildStellarAssetIdentifier(
  code: string,
  issuer?: string,
): Sep38StellarAssetIdentifier {
  return parseSep38AssetIdentifier(
    `stellar:${issuer === undefined ? code : `${encodeSep11AssetCode(code)}:${issuer}`}`,
  ).value as Sep38StellarAssetIdentifier;
}

export function buildStellarLiquidityPoolAssetIdentifier(
  liquidityPoolId: string,
): Sep38StellarLiquidityPoolAssetIdentifier {
  return parseSep38AssetIdentifier(
    `stellar:${liquidityPoolId}:lp`,
  ).value as Sep38StellarLiquidityPoolAssetIdentifier;
}

export function normalizeSep38QuoteServer(quoteServer: string): string {
  try {
    const url = new URL(quoteServer);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      !isValidHomeDomain(url.hostname)
    ) {
      throw new Error("invalid quote server");
    }

    url.pathname = url.pathname.replace(/\/+$/, "");

    if (!url.pathname || url.pathname === "/") {
      url.pathname = "";
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Sep38ClientError(
      "INVALID_QUOTE_SERVER",
      "SEP-38 quote server must be a public HTTPS URL",
      safeEndpoint(quoteServer),
    );
  }
}

export function parseSep38Info(value: unknown, endpoint = "SEP-38 /info"): Sep38Info {
  const record = requireRecord(value, endpoint);
  const rawAssets = record.assets;

  if (!Array.isArray(rawAssets)) {
    throw invalidData("SEP-38 info assets must be an array", endpoint);
  }

  const assetsById = new Map<Sep38AssetIdentifier, Sep38Asset>();

  for (const rawAsset of rawAssets) {
    const assetRecord = requireRecord(rawAsset, endpoint);
    const asset = parseAsset(requireString(assetRecord.asset, "asset", endpoint));
    const parsed: Sep38Asset = Object.freeze({
      asset,
      countryCodes: parseCountryCodes(assetRecord.country_codes, endpoint),
      sellDeliveryMethods: parseDeliveryMethods(
        assetRecord.sell_delivery_methods,
        endpoint,
      ),
      buyDeliveryMethods: parseDeliveryMethods(
        assetRecord.buy_delivery_methods,
        endpoint,
      ),
    });

    const existing = assetsById.get(asset);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw invalidData("Conflicting duplicate SEP-38 asset", endpoint);
    }
    assetsById.set(asset, parsed);
  }

  return Object.freeze({
    assets: Object.freeze(
      [...assetsById.values()].sort((left, right) =>
        left.asset.localeCompare(right.asset),
      ),
    ),
  });
}

export async function getSep38Info(
  quoteServer: string,
  options: Sep38ClientOptions = {},
): Promise<Sep38Info> {
  const endpoint = buildEndpoint(quoteServer, "info");
  return parseSep38Info(await requestJson(endpoint, {}, options), endpoint);
}

export function parseSep38PricesResponse(
  value: unknown,
  request: Sep38PricesRequest,
  endpoint = "SEP-38 /prices",
): Sep38Prices {
  validatePricesRequest(request, endpoint);
  const record = requireRecord(value, endpoint);
  const isSell = request.sellAsset !== undefined;
  const rawPairs = record[isSell ? "buy_assets" : "sell_assets"];

  if (!Array.isArray(rawPairs)) {
    throw invalidData(
      `SEP-38 prices response must contain ${isSell ? "buy_assets" : "sell_assets"}`,
      endpoint,
    );
  }

  const pairsByKey = new Map<string, Sep38PairPrice>();

  for (const rawPair of rawPairs) {
    const pairRecord = requireRecord(rawPair, endpoint);
    const otherAsset = parseAsset(
      requireString(pairRecord.asset, "asset", endpoint),
    );
    const pair: Sep38PairPrice = Object.freeze({
      sellAsset: isSell ? request.sellAsset : otherAsset,
      buyAsset: isSell ? otherAsset : request.buyAsset,
      price: requireDecimal(pairRecord.price, "price", endpoint, true),
      decimals: requireInteger(pairRecord.decimals, "decimals", endpoint),
    });
    const key = pairKey(pair);
    const existing = pairsByKey.get(key);

    if (existing && JSON.stringify(existing) !== JSON.stringify(pair)) {
      throw invalidData("Conflicting duplicate SEP-38 pair", endpoint);
    }
    pairsByKey.set(key, pair);
  }

  return Object.freeze({
    direction: isSell ? "sell" : "buy",
    requestedAsset: isSell ? request.sellAsset : request.buyAsset,
    requestedAmount: isSell ? request.sellAmount : request.buyAmount,
    pairs: Object.freeze(
      [...pairsByKey.values()].sort((left, right) =>
        pairKey(left).localeCompare(pairKey(right)),
      ),
    ),
  });
}

export async function getSep38Prices(
  quoteServer: string,
  request: Sep38PricesRequest,
  options: Sep38ClientOptions = {},
): Promise<Sep38Prices> {
  const endpoint = buildEndpoint(quoteServer, "prices");
  validatePricesRequest(request, endpoint);
  const url = withQuery(endpoint, pricesQuery(request));
  return parseSep38PricesResponse(
    await requestJson(url, {}, options),
    request,
    endpoint,
  );
}

export async function discoverSep38Capabilities(
  quoteServer: string,
  options: Sep38ClientOptions = {},
): Promise<Sep38CapabilityDiscovery> {
  const normalizedServer = normalizeSep38QuoteServer(quoteServer);
  const info = await getSep38Info(normalizedServer, options);
  const pairsByKey = new Map<string, Sep38SupportedPair>();
  const failures: Sep38CapabilityDiscovery["failures"][number][] = [];

  for (const { asset } of info.assets) {
    try {
      const prices = await getSep38Prices(
        normalizedServer,
        { sellAsset: asset, sellAmount: "1" },
        options,
      );

      for (const { sellAsset, buyAsset } of prices.pairs) {
        const pair = Object.freeze({ sellAsset, buyAsset });
        pairsByKey.set(pairKey(pair), pair);
      }
    } catch (error) {
      const normalized = normalizeDiscoveryFailure(error, asset);
      failures.push(normalized);
    }
  }

  return Object.freeze({
    quoteServer: normalizedServer,
    info,
    pairs: Object.freeze(
      [...pairsByKey.values()].sort((left, right) =>
        pairKey(left).localeCompare(pairKey(right)),
      ),
    ),
    failures: Object.freeze(failures),
  });
}

export function parseSep38IndicativePrice(
  value: unknown,
  request: Sep38IndicativePriceRequest,
  endpoint = "SEP-38 /price",
): Sep38IndicativePrice {
  validateQuoteRequest(request, endpoint, false);
  const record = requireRecord(value, endpoint);

  return Object.freeze({
    sellAsset: request.sellAsset,
    buyAsset: request.buyAsset,
    totalPrice: requireDecimal(
      record.total_price,
      "total_price",
      endpoint,
      true,
    ),
    price: requireDecimal(record.price, "price", endpoint, true),
    sellAmount: requireDecimal(
      record.sell_amount,
      "sell_amount",
      endpoint,
      true,
    ),
    buyAmount: requireDecimal(
      record.buy_amount,
      "buy_amount",
      endpoint,
      true,
    ),
    fee: parseFee(record.fee, endpoint),
  });
}

export async function getSep38IndicativePrice(
  quoteServer: string,
  request: Sep38IndicativePriceRequest,
  options: Sep38ClientOptions = {},
): Promise<Sep38IndicativePrice> {
  const endpoint = buildEndpoint(quoteServer, "price");
  validateQuoteRequest(request, endpoint, false);
  const url = withQuery(endpoint, quoteQuery(request));
  return parseSep38IndicativePrice(
    await requestJson(url, {}, options),
    request,
    endpoint,
  );
}

export function buildSep38FirmQuoteRequest(
  request: Sep38FirmQuoteRequest,
  endpoint = "SEP-38 /quote",
): Sep38FirmQuoteWireRequest {
  validateQuoteRequest(request, endpoint, true);

  return Object.freeze({
    sell_asset: request.sellAsset,
    buy_asset: request.buyAsset,
    ...(request.sellAmount !== undefined
      ? { sell_amount: request.sellAmount }
      : { buy_amount: request.buyAmount }),
    ...(request.expireAfter ? { expire_after: request.expireAfter } : {}),
    ...(request.sellDeliveryMethod
      ? { sell_delivery_method: request.sellDeliveryMethod }
      : {}),
    ...(request.buyDeliveryMethod
      ? { buy_delivery_method: request.buyDeliveryMethod }
      : {}),
    ...(request.countryCode ? { country_code: request.countryCode } : {}),
    context: request.context,
  });
}

export function parseSep38FirmQuote(
  value: unknown,
  endpoint = "SEP-38 /quote",
  expectedRequest?: Sep38FirmQuoteRequest,
): Sep38FirmQuote {
  const record = requireRecord(value, endpoint);
  const id = requireString(record.id, "id", endpoint);
  const expiresAt = requireString(record.expires_at, "expires_at", endpoint);

  if (!isIsoDateTime(expiresAt)) {
    throw invalidData("SEP-38 expires_at must be a UTC ISO 8601 value", endpoint);
  }

  const quote = Object.freeze({
    id,
    expiresAt,
    totalPrice: requireDecimal(
      record.total_price,
      "total_price",
      endpoint,
      true,
    ),
    price: requireDecimal(record.price, "price", endpoint, true),
    sellAsset: parseAsset(
      requireString(record.sell_asset, "sell_asset", endpoint),
    ),
    sellAmount: requireDecimal(
      record.sell_amount,
      "sell_amount",
      endpoint,
      true,
    ),
    ...(record.sell_delivery_method !== undefined
      ? {
          sellDeliveryMethod: requireString(
            record.sell_delivery_method,
            "sell_delivery_method",
            endpoint,
          ),
        }
      : {}),
    buyAsset: parseAsset(
      requireString(record.buy_asset, "buy_asset", endpoint),
    ),
    buyAmount: requireDecimal(
      record.buy_amount,
      "buy_amount",
      endpoint,
      true,
    ),
    ...(record.buy_delivery_method !== undefined
      ? {
          buyDeliveryMethod: requireString(
            record.buy_delivery_method,
            "buy_delivery_method",
            endpoint,
          ),
        }
      : {}),
    fee: parseFee(record.fee, endpoint),
  });
  if (expectedRequest) {
    validateFirmQuoteMatchesRequest(quote, expectedRequest, endpoint);
  }

  return quote;
}

export async function requestSep38FirmQuote(
  quoteServer: string,
  request: Sep38FirmQuoteRequest,
  authentication: Sep38Authentication,
  options: Omit<Sep38ClientOptions, "authentication"> = {},
): Promise<Sep38FirmQuote> {
  const endpoint = buildEndpoint(quoteServer, "quote");
  const body = buildSep38FirmQuoteRequest(request, endpoint);
  requireAuthentication(authentication, endpoint);

  return parseSep38FirmQuote(
    await requestJson(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { ...options, authentication },
      201,
    ),
    endpoint,
    request,
  );
}

export async function getSep38FirmQuote(
  quoteServer: string,
  quoteId: string,
  authentication: Sep38Authentication,
  options: Omit<Sep38ClientOptions, "authentication"> = {},
): Promise<Sep38FirmQuote> {
  const cleanId = validateText(quoteId, "quote id", "SEP-38 /quote/:id");
  const endpoint = buildEndpoint(quoteServer, `quote/${encodeURIComponent(cleanId)}`);
  requireAuthentication(authentication, endpoint);
  return parseSep38FirmQuote(
    await requestJson(endpoint, {}, { ...options, authentication }),
    endpoint,
  );
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: Sep38ClientOptions,
  expectedStatus = 200,
): Promise<unknown> {
  const endpoint = safeEndpoint(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Sep38ClientError(
      "INVALID_REQUEST",
      "SEP-38 timeout must be a positive finite number",
      endpoint,
    );
  }

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (options.authentication) {
    requireAuthentication(options.authentication, endpoint);
    headers.set("Authorization", `Bearer ${options.authentication.token}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Sep38ClientError(
        "REDIRECT",
        "SEP-38 redirects are not allowed",
        endpoint,
        { status: response.status },
      );
    }

    if (response.status !== expectedStatus) {
      throw new Sep38ClientError(
        "HTTP_FAILURE",
        `SEP-38 request returned HTTP ${response.status}`,
        endpoint,
        { status: response.status },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new Sep38ClientError(
        "INVALID_CONTENT_TYPE",
        "SEP-38 response must use application/json",
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
      throw new Sep38ClientError(
        "INVALID_JSON",
        "SEP-38 response is not valid JSON",
        endpoint,
      );
    }
  } catch (error) {
    if (error instanceof Sep38ClientError) throw error;

    if (controller.signal.aborted) {
      throw new Sep38ClientError(
        "TIMEOUT",
        `SEP-38 request timed out after ${timeoutMs}ms`,
        endpoint,
      );
    }

    throw new Sep38ClientError(
      "NETWORK_FAILURE",
      "SEP-38 network request failed",
      endpoint,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildEndpoint(quoteServer: string, path: string): string {
  const base = normalizeSep38QuoteServer(quoteServer);
  return `${base}/${path}`;
}

function withQuery(endpoint: string, values: Record<string, string | undefined>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function pricesQuery(
  request: Sep38PricesRequest,
): Record<string, string | undefined> {
  return {
    ...(request.sellAsset !== undefined
      ? { sell_asset: request.sellAsset, sell_amount: request.sellAmount }
      : { buy_asset: request.buyAsset, buy_amount: request.buyAmount }),
    sell_delivery_method: request.sellDeliveryMethod,
    buy_delivery_method: request.buyDeliveryMethod,
    country_code: request.countryCode,
  };
}

function quoteQuery(
  request: Sep38IndicativePriceRequest,
): Record<string, string | undefined> {
  return {
    sell_asset: request.sellAsset,
    buy_asset: request.buyAsset,
    ...(request.sellAmount !== undefined
      ? { sell_amount: request.sellAmount }
      : { buy_amount: request.buyAmount }),
    sell_delivery_method: request.sellDeliveryMethod,
    buy_delivery_method: request.buyDeliveryMethod,
    country_code: request.countryCode,
    context: request.context,
  };
}

function validatePricesRequest(request: Sep38PricesRequest, endpoint: string): void {
  const hasSellDirection =
    request.sellAsset !== undefined || request.sellAmount !== undefined;
  const hasBuyDirection =
    request.buyAsset !== undefined || request.buyAmount !== undefined;

  if (hasSellDirection === hasBuyDirection) {
    throw invalidRequest(
      "Exactly one SEP-38 prices direction is required",
      endpoint,
    );
  }

  if (request.sellAsset !== undefined && request.sellAmount !== undefined) {
    parseSep38AssetIdentifier(request.sellAsset);
    validateDecimal(request.sellAmount, "sellAmount", endpoint, true);
  } else if (request.buyAsset !== undefined && request.buyAmount !== undefined) {
    parseSep38AssetIdentifier(request.buyAsset);
    validateDecimal(request.buyAmount, "buyAmount", endpoint, true);
  } else {
    throw invalidRequest(
      "SEP-38 prices direction requires an asset and amount",
      endpoint,
    );
  }

  validateOptionalRequestFields(request, endpoint);
}

function validateQuoteRequest(
  request: Sep38IndicativePriceRequest | Sep38FirmQuoteRequest,
  endpoint: string,
  firm: boolean,
): void {
  parseSep38AssetIdentifier(request.sellAsset);
  parseSep38AssetIdentifier(request.buyAsset);
  if (request.sellAsset === request.buyAsset) {
    throw invalidRequest("SEP-38 sell and buy assets must differ", endpoint);
  }

  const hasSellAmount = request.sellAmount !== undefined;
  const hasBuyAmount = request.buyAmount !== undefined;
  if (hasSellAmount === hasBuyAmount) {
    throw invalidRequest("Exactly one SEP-38 quote amount is required", endpoint);
  }

  if (request.sellAmount !== undefined) {
    validateDecimal(request.sellAmount, "sellAmount", endpoint, true);
  } else if (request.buyAmount !== undefined) {
    validateDecimal(request.buyAmount, "buyAmount", endpoint, true);
  }

  const contexts: readonly string[] = firm
    ? ["sep6", "sep24", "sep31"]
    : ["sep6", "sep31"];
  if (!contexts.includes(request.context)) {
    throw invalidRequest("SEP-38 context is invalid", endpoint);
  }

  if (request.sellDeliveryMethod && request.buyDeliveryMethod) {
    throw invalidRequest(
      "SEP-38 requests cannot specify both delivery methods",
      endpoint,
    );
  }

  if (firm && "expireAfter" in request && request.expireAfter) {
    if (!isIsoDateTime(request.expireAfter)) {
      throw invalidRequest(
        "SEP-38 expireAfter must be a UTC ISO 8601 value",
        endpoint,
      );
    }
  }

  validateOptionalRequestFields(request, endpoint);
}

function validateOptionalRequestFields(
  request: Readonly<{
    sellDeliveryMethod?: string;
    buyDeliveryMethod?: string;
    countryCode?: string;
  }>,
  endpoint: string,
): void {
  if (request.sellDeliveryMethod !== undefined) {
    validateText(request.sellDeliveryMethod, "sellDeliveryMethod", endpoint);
  }
  if (request.buyDeliveryMethod !== undefined) {
    validateText(request.buyDeliveryMethod, "buyDeliveryMethod", endpoint);
  }
  if (
    request.countryCode !== undefined &&
    !COUNTRY_CODE_PATTERN.test(request.countryCode)
  ) {
    throw invalidRequest("SEP-38 countryCode is invalid", endpoint);
  }
}

function parseFee(value: unknown, endpoint: string): Sep38Fee {
  const record = requireRecord(value, endpoint);
  const detailsValue = record.details;
  const details = detailsValue === undefined
    ? []
    : (() => {
        if (!Array.isArray(detailsValue)) {
          throw invalidData("SEP-38 fee details must be an array", endpoint);
        }
        return detailsValue.map((detail) => {
          const item = requireRecord(detail, endpoint);
          return Object.freeze({
            name: requireString(item.name, "fee.details.name", endpoint),
            ...(item.description !== undefined
              ? {
                  description: requireString(
                    item.description,
                    "fee.details.description",
                    endpoint,
                  ),
                }
              : {}),
            amount: requireDecimal(
              item.amount,
              "fee.details.amount",
              endpoint,
              false,
            ),
          });
        });
      })();

  return Object.freeze({
    total: requireDecimal(record.total, "fee.total", endpoint, false),
    asset: parseAsset(requireString(record.asset, "fee.asset", endpoint)),
    details: Object.freeze(details),
  });
}

function parseDeliveryMethods(
  value: unknown,
  endpoint: string,
): readonly Sep38DeliveryMethod[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw invalidData("SEP-38 delivery methods must be an array", endpoint);
  }

  return Object.freeze(
    value.map((entry) => {
      const record = requireRecord(entry, endpoint);
      return Object.freeze({
        name: requireString(record.name, "delivery method name", endpoint),
        description: requireString(
          record.description,
          "delivery method description",
          endpoint,
        ),
      });
    }),
  );
}

function parseCountryCodes(value: unknown, endpoint: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw invalidData("SEP-38 country_codes must be an array", endpoint);
  }

  const codes = new Set<string>();
  for (const item of value) {
    const code = requireString(item, "country code", endpoint);
    if (!COUNTRY_CODE_PATTERN.test(code)) {
      throw invalidData("Invalid SEP-38 country code", endpoint);
    }
    codes.add(code);
  }
  return Object.freeze([...codes].sort());
}

function parseAsset(value: string): Sep38AssetIdentifier {
  return parseSep38AssetIdentifier(value).value;
}

function requireRecord(value: unknown, endpoint: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidData("SEP-38 response must be a JSON object", endpoint);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidData(`SEP-38 ${field} must be a non-empty string`, endpoint);
  }
  return value.trim();
}

function requireDecimal(
  value: unknown,
  field: string,
  endpoint: string,
  positive: boolean,
): string {
  if (typeof value !== "string") {
    throw invalidData(`SEP-38 ${field} must be a numeric string`, endpoint);
  }
  validateDecimal(value, field, endpoint, positive, true);
  return value;
}

function validateDecimal(
  value: string,
  field: string,
  endpoint: string,
  positive: boolean,
  response = false,
): void {
  if (!DECIMAL_PATTERN.test(value) || (positive && /^0(?:\.0+)?$/.test(value))) {
    const message = `SEP-38 ${field} must be a ${positive ? "positive " : ""}decimal string`;
    throw response ? invalidData(message, endpoint) : invalidRequest(message, endpoint);
  }
}

function requireInteger(value: unknown, field: string, endpoint: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidData(`SEP-38 ${field} must be a non-negative integer`, endpoint);
  }
  return value as number;
}

function validateText(value: string, field: string, endpoint: string): string {
  if (!value.trim() || /[\r\n]/.test(value)) {
    throw invalidRequest(`SEP-38 ${field} must be a non-empty single-line string`, endpoint);
  }
  return value.trim();
}

function requireAuthentication(
  authentication: Sep38Authentication,
  endpoint: string,
): void {
  if (!authentication || !authentication.token.trim() || /[\r\n]/.test(authentication.token)) {
    throw new Sep38ClientError(
      "AUTHENTICATION_REQUIRED",
      "SEP-38 firm quote operations require a SEP-10 or SEP-45 token",
      endpoint,
    );
  }
}

function normalizeDiscoveryFailure(
  error: unknown,
  asset: Sep38AssetIdentifier,
): Sep38CapabilityDiscovery["failures"][number] {
  if (error instanceof Sep38ClientError) {
    return Object.freeze({
      asset,
      code: error.code,
      ...(error.status !== undefined ? { status: error.status } : {}),
    });
  }
  return Object.freeze({ asset, code: "UNEXPECTED" });
}

async function readBoundedBody(response: Response, endpoint: string): Promise<string> {
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

function responseTooLarge(endpoint: string): Sep38ClientError {
  return new Sep38ClientError(
    "RESPONSE_TOO_LARGE",
    `SEP-38 response exceeds ${MAX_JSON_BYTES} bytes`,
    endpoint,
  );
}

function pairKey(pair: Sep38SupportedPair): string {
  return `${pair.sellAsset}->${pair.buyAsset}`;
}

function validateFirmQuoteMatchesRequest(
  quote: Sep38FirmQuote,
  request: Sep38FirmQuoteRequest,
  endpoint: string,
): void {
  if (
    quote.sellAsset !== request.sellAsset ||
    quote.buyAsset !== request.buyAsset ||
    quote.sellDeliveryMethod !== request.sellDeliveryMethod ||
    quote.buyDeliveryMethod !== request.buyDeliveryMethod
  ) {
    throw invalidData(
      "SEP-38 quote response does not match its request",
      endpoint,
    );
  }
}

function findSep11AssetSeparator(identifier: string): number {
  for (let index = 0; index < identifier.length; index += 1) {
    if (identifier[index] === ":") return index;
    if (identifier[index] !== "\\") continue;
    if (identifier[index + 1] === "x") {
      index += 3;
    } else {
      index += 1;
    }
  }
  return -1;
}

function decodeSep11AssetCode(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === ":" || escaped === "\\") {
      decoded += escaped;
      index += 1;
      continue;
    }

    const hex = value.slice(index + 2, index + 4);
    if (escaped !== "x" || !/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw invalidAsset();
    }
    decoded += String.fromCharCode(Number.parseInt(hex, 16));
    index += 3;
  }

  return decoded;
}

function encodeSep11AssetCode(value: string): string {
  if (!STELLAR_CODE_PATTERN.test(value)) throw invalidAsset();
  return value.replace(/[\\:]/g, (character) => `\\${character}`);
}

function isValidStellarIssuer(value: string): boolean {
  if (!STELLAR_ISSUER_PATTERN.test(value)) return false;
  const decoded = decodeBase32(value);
  if (!decoded || decoded.length !== 35 || decoded[0] !== 6 << 3) return false;

  const checksum = crc16Xmodem(decoded.subarray(0, 33));
  return decoded[33] === (checksum & 0xff) && decoded[34] === (checksum >> 8);
}

function decodeBase32(value: string): Uint8Array | undefined {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  return bits === 0 || buffer === 0 ? Uint8Array.from(bytes) : undefined;
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function isIsoDateTime(value: string): boolean {
  return (
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/quote\/[^/]+$/, "/quote/:id");
    return url.toString();
  } catch {
    return "SEP-38 endpoint";
  }
}

function invalidAsset(): Sep38ClientError {
  return new Sep38ClientError(
    "INVALID_ASSET",
    "Invalid or unsupported SEP-38 asset identifier",
    "SEP-38 asset identifier",
  );
}

function invalidRequest(message: string, endpoint: string): Sep38ClientError {
  return new Sep38ClientError("INVALID_REQUEST", message, safeEndpoint(endpoint));
}

function invalidData(message: string, endpoint: string): Sep38ClientError {
  return new Sep38ClientError("INVALID_DATA", message, safeEndpoint(endpoint));
}
