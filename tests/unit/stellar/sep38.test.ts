import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIso4217AssetIdentifier,
  buildSep38FirmQuoteRequest,
  buildStellarAssetIdentifier,
  buildStellarLiquidityPoolAssetIdentifier,
  discoverSep38Capabilities,
  getSep38IndicativePrice,
  getSep38FirmQuote,
  getSep38Info,
  normalizeSep38QuoteServer,
  parseSep38AssetIdentifier,
  parseSep38FirmQuote,
  parseSep38IndicativePrice,
  parseSep38PricesResponse,
  requestSep38FirmQuote,
  Sep38ClientError,
} from "@/lib/stellar/sep38";
import type {
  Sep38FirmQuoteRequest,
  Sep38IndicativePriceRequest,
  Sep38PricesRequest,
} from "@/types/sep38";

const USDC = buildStellarAssetIdentifier(
  "USDC",
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
);
const BRL = buildIso4217AssetIdentifier("BRL");
const QUOTE_SERVER = "https://anchor.example/sep38";

test("SEP-38 asset identifiers validate supported protocol schemes", () => {
  assert.deepEqual(parseSep38AssetIdentifier(BRL), {
    scheme: "iso4217",
    code: "BRL",
    value: "iso4217:BRL",
  });
  assert.deepEqual(parseSep38AssetIdentifier(USDC), {
    scheme: "stellar",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    value: USDC,
  });
  assert.equal(buildStellarAssetIdentifier("native"), "stellar:native");
  const liquidityPoolId = "a".repeat(64);
  assert.deepEqual(
    parseSep38AssetIdentifier(
      buildStellarLiquidityPoolAssetIdentifier(liquidityPoolId),
    ),
    {
      scheme: "stellar",
      liquidityPoolId,
      value: `stellar:${liquidityPoolId}:lp`,
    },
  );
  assert.throws(
    () => buildStellarLiquidityPoolAssetIdentifier("A".repeat(64)),
    hasCode("INVALID_ASSET"),
  );
});

test("SEP-38 asset identifiers reject malformed and undocumented schemes", () => {
  for (const value of [
    "iso4217:usd",
    "iso4217:USDD",
    "crypto:BTC",
    "stellar:USDC:not-an-issuer",
    "stellar:",
  ]) {
    assert.throws(
      () => parseSep38AssetIdentifier(value),
      (error) =>
        error instanceof Sep38ClientError && error.code === "INVALID_ASSET",
    );
  }
});

test("quote-server normalization enforces a public HTTPS network boundary", () => {
  assert.equal(
    normalizeSep38QuoteServer("https://anchor.example/sep38/"),
    QUOTE_SERVER,
  );

  for (const value of [
    "http://anchor.example/sep38",
    "https://localhost/sep38",
    "https://127.0.0.1/sep38",
    "https://user:secret@anchor.example/sep38",
    "https://anchor.example:8443/sep38",
    "https://anchor.example/sep38?token=secret",
  ]) {
    assert.throws(
      () => normalizeSep38QuoteServer(value),
      (error) =>
        error instanceof Sep38ClientError &&
        error.code === "INVALID_QUOTE_SERVER" &&
        !error.message.includes("secret") &&
        !error.endpoint.includes("secret"),
    );
  }
});

test("supported pair parsing deduplicates identical pairs and freezes results", () => {
  const prices = parseSep38PricesResponse(
    {
      buy_assets: [
        { asset: BRL, price: "0.18", decimals: 2 },
        { asset: BRL, price: "0.18", decimals: 2 },
      ],
    },
    { sellAsset: USDC, sellAmount: "100" },
  );

  assert.deepEqual(prices.pairs, [
    { sellAsset: USDC, buyAsset: BRL, price: "0.18", decimals: 2 },
  ]);
  assert.equal(Object.isFrozen(prices), true);
  assert.equal(Object.isFrozen(prices.pairs), true);
  assert.equal(Object.isFrozen(prices.pairs[0]), true);
});

test("supported pair parsing rejects conflicting duplicates and wrong shapes", () => {
  assert.throws(
    () =>
      parseSep38PricesResponse(
        {
          buy_assets: [
            { asset: BRL, price: "0.18", decimals: 2 },
            { asset: BRL, price: "0.19", decimals: 2 },
          ],
        },
        { sellAsset: USDC, sellAmount: "100" },
      ),
    (error) =>
      error instanceof Sep38ClientError &&
      error.code === "INVALID_DATA" &&
      !error.message.includes(USDC) &&
      !error.message.includes(BRL),
  );

  assert.throws(
    () =>
      parseSep38PricesResponse(
        { buy_assets: "not-an-array" },
        { sellAsset: USDC, sellAmount: "100" },
      ),
    (error) =>
      error instanceof Sep38ClientError && error.code === "INVALID_DATA",
  );
});

test("capability discovery derives pairs from /prices and isolates per-asset failures", async () => {
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/info")) {
      return jsonResponse({
        assets: [{ asset: USDC }, { asset: BRL }, { asset: "stellar:native" }],
      });
    }

    const sellAsset = url.searchParams.get("sell_asset");
    if (sellAsset === USDC) {
      return jsonResponse({
        buy_assets: [{ asset: BRL, price: "0.18", decimals: 2 }],
      });
    }
    if (sellAsset === BRL) {
      return jsonResponse({
        buy_assets: [{ asset: USDC, price: "5.42", decimals: 2 }],
      });
    }
    return jsonResponse({ error: "unsupported" }, 400);
  }) as typeof fetch;

  const discovery = await discoverSep38Capabilities(QUOTE_SERVER, { fetcher });

  assert.deepEqual(discovery.pairs, [
    { sellAsset: BRL, buyAsset: USDC },
    { sellAsset: USDC, buyAsset: BRL },
  ]);
  assert.deepEqual(discovery.failures, [
    { asset: "stellar:native", code: "HTTP_FAILURE", status: 400 },
  ]);
  assert.equal(Object.isFrozen(discovery), true);
  assert.equal(Object.isFrozen(discovery.pairs), true);
  assert.equal(Object.isFrozen(discovery.failures), true);
  assert.equal(Object.isFrozen(discovery.info.assets), true);
  assert.equal(Object.isFrozen(discovery.info.assets[0]), true);
  assert.equal(Object.isFrozen(discovery.info.assets[0]?.countryCodes), true);
});

test("network client rejects invalid JSON, content types, and non-2xx responses", async () => {
  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: async () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
    }),
    hasCode("INVALID_JSON"),
  );

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: async () => new Response('{"assets":[]}', {
        headers: { "content-type": "text/plain" },
      }),
    }),
    hasCode("INVALID_CONTENT_TYPE"),
  );

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: async () => jsonResponse({ error: "private detail" }, 503),
    }),
    (error) =>
      error instanceof Sep38ClientError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 503 &&
      !error.message.includes("private detail"),
  );
});

test("network client rejects redirects without following them", async () => {
  let redirectMode: RequestRedirect | undefined;

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: (async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/info" },
        });
      }) as typeof fetch,
    }),
    hasCode("REDIRECT"),
  );

  assert.equal(redirectMode, "manual");
});

test("network client aborts timeouts while reading and bounds JSON bodies", async () => {
  const slowFetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, { fetcher: slowFetcher, timeoutMs: 5 }),
    hasCode("TIMEOUT"),
  );

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: async () =>
        new Response(`{"padding":"${"x".repeat(100_001)}"}`, {
          headers: { "content-type": "application/json" },
        }),
    }),
    hasCode("RESPONSE_TOO_LARGE"),
  );
});

test("indicative prices preserve decimal strings and normalize nested fees", () => {
  const request = indicativeRequest();
  const price = parseSep38IndicativePrice(
    {
      total_price: "0.18",
      price: "0.17",
      sell_amount: "100",
      buy_amount: "17",
      fee: {
        total: "1.00",
        asset: BRL,
        details: [{ name: "Service fee", amount: "1.00", future: true }],
      },
      future: true,
    },
    request,
  );

  assert.deepEqual(price, {
    sellAsset: USDC,
    buyAsset: BRL,
    totalPrice: "0.18",
    price: "0.17",
    sellAmount: "100",
    buyAmount: "17",
    fee: {
      total: "1.00",
      asset: BRL,
      details: [{ name: "Service fee", amount: "1.00" }],
    },
  });
  assert.equal(Object.isFrozen(price.fee), true);
  assert.equal(Object.isFrozen(price.fee.details), true);
});

test("indicative price requests reject malformed numeric strings", async () => {
  await assert.rejects(
    getSep38IndicativePrice(
      QUOTE_SERVER,
      {
        sellAsset: USDC,
        buyAsset: BRL,
        sellAmount: "1e6",
        context: "sep31",
      },
      { fetcher: async () => jsonResponse({}) },
    ),
    hasCode("INVALID_REQUEST"),
  );
});

test("indicative responses may adjust requested amounts when fees apply", () => {
  const response = firmQuoteResponse();
  response.sell_amount = "101";

  assert.equal(
    parseSep38IndicativePrice(response, indicativeRequest()).sellAmount,
    "101",
  );
});

test("firm quote construction uses protocol wire names and one amount direction", () => {
  const request: Sep38FirmQuoteRequest = {
    sellAsset: USDC,
    buyAsset: BRL,
    sellAmount: "100",
    buyDeliveryMethod: "PIX",
    countryCode: "BR",
    context: "sep24",
    expireAfter: "2026-08-20T12:00:00Z",
  };

  assert.deepEqual(buildSep38FirmQuoteRequest(request), {
    sell_asset: USDC,
    buy_asset: BRL,
    sell_amount: "100",
    expire_after: "2026-08-20T12:00:00Z",
    buy_delivery_method: "PIX",
    country_code: "BR",
    context: "sep24",
  });
});

test("firm quote parsing validates required fields while tolerating additions", () => {
  const quote = parseSep38FirmQuote(firmQuoteResponse());

  assert.equal(quote.id, "quote-123");
  assert.equal(quote.totalPrice, "0.18");
  assert.equal(quote.fee.total, "1.00");
  assert.equal(Object.isFrozen(quote), true);
  assert.equal(Object.isFrozen(quote.fee.details), true);
});

test("firm quote requests require an explicit token and never leak it", async () => {
  const request: Sep38FirmQuoteRequest = {
    sellAsset: USDC,
    buyAsset: BRL,
    sellAmount: "100",
    context: "sep31",
  };

  await assert.rejects(
    requestSep38FirmQuote(QUOTE_SERVER, request, { token: "" }),
    hasCode("AUTHENTICATION_REQUIRED"),
  );

  const token = "sensitive.jwt.value";
  let authorization: string | null = null;
  let sentBody: unknown;
  const quote = await requestSep38FirmQuote(
    QUOTE_SERVER,
    request,
    { token },
    {
      fetcher: (async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        sentBody = JSON.parse(String(init?.body));
        return jsonResponse(firmQuoteResponse(), 201);
      }) as typeof fetch,
    },
  );

  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(sentBody, {
    sell_asset: USDC,
    buy_asset: BRL,
    sell_amount: "100",
    context: "sep31",
  });
  assert.equal(quote.id, "quote-123");

  await assert.rejects(
    requestSep38FirmQuote(QUOTE_SERVER, request, { token }, {
      fetcher: async () => jsonResponse({ error: token }, 403),
    }),
    (error) =>
      error instanceof Sep38ClientError &&
      !error.message.includes(token) &&
      !error.endpoint.includes(token),
  );
});

test("SEP-38 stellar assets implement SEP-11 escaping and StrKey checksums", () => {
  const issuer =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const asset = buildStellarAssetIdentifier("A:B", issuer);

  assert.equal(asset, `stellar:A\\:B:${issuer}`);
  assert.equal(parseSep38AssetIdentifier(asset).code, "A:B");

  assert.throws(
    () => buildStellarAssetIdentifier("A B", issuer),
    hasCode("INVALID_ASSET"),
  );

  const corruptedIssuer = `${issuer.slice(0, -1)}A`;
  assert.throws(
    () => parseSep38AssetIdentifier(`stellar:USDC:${corruptedIssuer}`),
    hasCode("INVALID_ASSET"),
  );
});

test("runtime validation enforces exclusive directions, amounts, and delivery methods", () => {
  assert.throws(
    () =>
      parseSep38PricesResponse(
        { buy_assets: [] },
        {
          sellAsset: USDC,
          sellAmount: "1",
          buyAsset: BRL,
          buyAmount: "1",
        } as unknown as Sep38PricesRequest,
      ),
    hasCode("INVALID_REQUEST"),
  );

  assert.throws(
    () =>
      parseSep38IndicativePrice(
        {},
        {
          ...indicativeRequest(),
          buyAmount: "17",
        } as unknown as Sep38IndicativePriceRequest,
      ),
    hasCode("INVALID_REQUEST"),
  );

  assert.throws(
    () =>
      parseSep38IndicativePrice(
        {},
        {
          ...indicativeRequest(),
          sellDeliveryMethod: "cash",
        } as unknown as Sep38IndicativePriceRequest,
      ),
    hasCode("INVALID_REQUEST"),
  );

  assert.throws(
    () =>
      parseSep38IndicativePrice(
        {},
        {
          ...indicativeRequest(),
          context: "sep24",
        } as unknown as Sep38IndicativePriceRequest,
      ),
    hasCode("INVALID_REQUEST"),
  );
});

test("network boundary requires the exact JSON media type and exact success status", async () => {
  await assert.rejects(
    getSep38Info(QUOTE_SERVER, {
      fetcher: async () =>
        new Response(`{"assets":[]}`, {
          headers: { "content-type": "application/jsonp" },
        }),
    }),
    hasCode("INVALID_CONTENT_TYPE"),
  );

  await assert.rejects(
    requestSep38FirmQuote(
      QUOTE_SERVER,
      {
        sellAsset: USDC,
        buyAsset: BRL,
        sellAmount: "100",
        context: "sep31",
      },
      { token: "reference-token" },
      { fetcher: async () => jsonResponse(firmQuoteResponse(), 200) },
    ),
    hasCode("HTTP_FAILURE"),
  );
});

test("public endpoints accept caller-supplied auth and quote ids stay within the path", async () => {
  const token = "reference-token";
  let publicAuthorization: string | null = null;
  await getSep38Info(QUOTE_SERVER, {
    authentication: { token },
    fetcher: (async (_input, init) => {
      publicAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ assets: [] });
    }) as typeof fetch,
  });
  assert.equal(publicAuthorization, `Bearer ${token}`);

  let requestedUrl = "";
  await getSep38FirmQuote(QUOTE_SERVER, "a/b?c", { token }, {
    fetcher: (async (input) => {
      requestedUrl = String(input);
      return jsonResponse(firmQuoteResponse());
    }) as typeof fetch,
  });
  assert.equal(requestedUrl, `${QUOTE_SERVER}/quote/a%2Fb%3Fc`);
  const quoteId = "sensitive-quote-id";
  await assert.rejects(
    getSep38FirmQuote(QUOTE_SERVER, quoteId, { token }, {
      fetcher: async () => jsonResponse({ error: "not found" }, 404),
    }),
    (error) =>
      error instanceof Sep38ClientError &&
      !error.endpoint.includes(quoteId) &&
      error.endpoint.endsWith("/quote/:id"),
  );
});

test("response-body reads remain covered by the request timeout", async () => {
  const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new Error("aborted"));
          });
        },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  await assert.rejects(
    getSep38Info(QUOTE_SERVER, { fetcher, timeoutMs: 5 }),
    hasCode("TIMEOUT"),
  );
});

test("firm quote responses must match the submitted pair", async () => {
  const response = firmQuoteResponse();
  response.buy_asset = "stellar:native";

  await assert.rejects(
    requestSep38FirmQuote(
      QUOTE_SERVER,
      {
        sellAsset: USDC,
        buyAsset: BRL,
        sellAmount: "100.0",
        context: "sep31",
      },
      { token: "reference-token" },
      { fetcher: async () => jsonResponse(response, 201) },
    ),
    hasCode("INVALID_DATA"),
  );
});

function indicativeRequest(): Sep38IndicativePriceRequest {
  return {
    sellAsset: USDC,
    buyAsset: BRL,
    sellAmount: "100",
    buyDeliveryMethod: "PIX",
    countryCode: "BR",
    context: "sep31",
  };
}

function firmQuoteResponse(): Record<string, unknown> {
  return {
    id: "quote-123",
    expires_at: "2026-08-20T12:05:00Z",
    total_price: "0.18",
    price: "0.17",
    sell_asset: USDC,
    sell_amount: "100",
    buy_asset: BRL,
    buy_amount: "17",
    fee: {
      total: "1.00",
      asset: BRL,
      details: [{ name: "Service fee", amount: "1.00" }],
    },
    additive_protocol_field: true,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Sep38ClientError && error.code === code;
}
