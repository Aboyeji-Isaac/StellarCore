import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIso4217AssetIdentifier,
  buildStellarAssetIdentifier,
  getSep38IndicativePrice,
  requestSep38FirmQuote,
  Sep38ClientError,
} from "@/lib/stellar/sep38";

const USDC = buildStellarAssetIdentifier(
  "USDC",
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
);
const BRL = buildIso4217AssetIdentifier("BRL");
const QUOTE_SERVER = "https://anchor.example/sep38";

test("indicative quote fetching rejects malformed JSON and non-JSON responses", async () => {
  await assert.rejects(
    getSep38IndicativePrice(QUOTE_SERVER, indicativeRequest(), {
      fetcher: async () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
    }),
    hasCode("INVALID_JSON"),
  );

  await assert.rejects(
    getSep38IndicativePrice(QUOTE_SERVER, indicativeRequest(), {
      fetcher: async () =>
        new Response(JSON.stringify(indicativeResponse()), {
          headers: { "content-type": "text/plain" },
        }),
    }),
    hasCode("INVALID_CONTENT_TYPE"),
  );
});

test("indicative quote fetching reports upstream non-200 responses", async () => {
  await assert.rejects(
    getSep38IndicativePrice(QUOTE_SERVER, indicativeRequest(), {
      fetcher: async () => jsonResponse({ error: "unavailable" }, 503),
    }),
    (error) =>
      error instanceof Sep38ClientError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 503,
  );
});

test("indicative quote fetching aborts when the upstream times out", async () => {
  const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;

  await assert.rejects(
    getSep38IndicativePrice(
      QUOTE_SERVER,
      indicativeRequest(),
      { fetcher, timeoutMs: 5 },
    ),
    hasCode("TIMEOUT"),
  );
});

test("firm quote fetching rejects a 200 response for the wrong asset pair", async () => {
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
      {
        fetcher: async () =>
          jsonResponse({
            ...firmQuoteResponse(),
            buy_asset: "stellar:native",
          }, 201),
      },
    ),
    hasCode("INVALID_DATA"),
  );
});

function indicativeRequest() {
  return {
    sellAsset: USDC,
    buyAsset: BRL,
    sellAmount: "100",
    context: "sep31" as const,
  };
}

function indicativeResponse() {
  return {
    total_price: "0.18",
    price: "0.17",
    sell_amount: "100",
    buy_amount: "17",
  };
}

function firmQuoteResponse() {
  return {
    id: "quote-123",
    expires_at: "2026-08-20T12:05:00Z",
    total_price: "0.18",
    price: "0.17",
    sell_asset: USDC,
    sell_amount: "100",
    buy_asset: BRL,
    buy_amount: "17",
    fee: { total: "1.00", asset: BRL, details: [] },
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
