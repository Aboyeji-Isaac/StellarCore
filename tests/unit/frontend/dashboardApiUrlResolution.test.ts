import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchDashboardApi,
  InvalidApiUrlConfigurationError,
  resolveApiUrl,
} from "@/lib/api/resolveApiUrl";

test("relative-path strategy returns clean root-relative path", () => {
  assert.equal(
    resolveApiUrl("/api/rates", { strategy: "relative" }),
    "/api/rates",
  );
  assert.equal(
    resolveApiUrl("api/rates?corridor=usdc-us-brl-br", { strategy: "relative" }),
    "/api/rates?corridor=usdc-us-brl-br",
  );
  assert.equal(
    resolveApiUrl("/api/anchors", { strategy: "relative", baseUrl: "https://stellarcore.org" }),
    "/api/anchors",
    "explicit strategy='relative' overrides configured baseUrl",
  );
});

test("default without configured base URL uses relative-path strategy", () => {
  assert.equal(resolveApiUrl("/api/anchors", { env: {} }), "/api/anchors");
  assert.equal(
    resolveApiUrl("api/corridors/usdc-us-brl-br", { env: {} }),
    "/api/corridors/usdc-us-brl-br",
  );
});

test("local configuration resolves to local origin or relative consistently", () => {
  // Local environment with explicit NEXT_PUBLIC_API_URL
  const localEnv = { NEXT_PUBLIC_API_URL: "http://localhost:3000" };
  assert.equal(
    resolveApiUrl("/api/rates", { env: localEnv }),
    "http://localhost:3000/api/rates",
  );
  assert.equal(
    resolveApiUrl("/api/rates/history?corridor=usdc-us-brl-br&days=30", { env: localEnv }),
    "http://localhost:3000/api/rates/history?corridor=usdc-us-brl-br&days=30",
  );

  // Local environment with localhost shorthand without protocol
  assert.equal(
    resolveApiUrl("/api/reputation", { baseUrl: "localhost:3000" }),
    "http://localhost:3000/api/reputation",
  );
});

test("preview configuration resolves from VERCEL_URL and NEXT_PUBLIC_API_URL", () => {
  // Vercel preview domain (bare host from VERCEL_URL)
  const vercelEnv = { VERCEL_URL: "stellarcore-git-preview-branch.vercel.app" };
  assert.equal(
    resolveApiUrl("/api/anchors", { env: vercelEnv }),
    "https://stellarcore-git-preview-branch.vercel.app/api/anchors",
  );

  // Preview environment with explicit https VERCEL_URL
  const vercelHttpsEnv = { VERCEL_URL: "https://preview-123.vercel.app" };
  assert.equal(
    resolveApiUrl("/api/corridors", { env: vercelHttpsEnv }),
    "https://preview-123.vercel.app/api/corridors",
  );

  // Preview environment with NEXT_PUBLIC_APP_URL
  const previewAppUrlEnv = { NEXT_PUBLIC_APP_URL: "https://preview.stellarcore.org" };
  assert.equal(
    resolveApiUrl("/api/rates", { env: previewAppUrlEnv }),
    "https://preview.stellarcore.org/api/rates",
  );
});

test("production-like configuration resolves to configured production origin", () => {
  const prodEnv = { NEXT_PUBLIC_API_URL: "https://stellarcore.org" };
  assert.equal(
    resolveApiUrl("/api/anchors", { env: prodEnv }),
    "https://stellarcore.org/api/anchors",
  );
  assert.equal(
    resolveApiUrl("/api/corridors/usdc-us-brl-br", { env: prodEnv }),
    "https://stellarcore.org/api/corridors/usdc-us-brl-br",
  );
  assert.equal(
    resolveApiUrl("/api/rates/history?corridor=usdc-us-brl-br&days=7", { env: prodEnv }),
    "https://stellarcore.org/api/rates/history?corridor=usdc-us-brl-br&days=7",
  );
});

test("URL resolution does not duplicate path prefixes", () => {
  // 1. Base URL ends with /api and target path begins with /api
  assert.equal(
    resolveApiUrl("/api/rates", { baseUrl: "https://stellarcore.org/api" }),
    "https://stellarcore.org/api/rates",
    "must not produce /api/api/rates",
  );

  // 2. Base URL ends with /api/ (trailing slash) and target is /api/anchors
  assert.equal(
    resolveApiUrl("/api/anchors", { baseUrl: "https://stellarcore.org/api/" }),
    "https://stellarcore.org/api/anchors",
  );

  // 3. Base URL ends with /api and target has no leading slash: api/corridors
  assert.equal(
    resolveApiUrl("api/corridors", { baseUrl: "https://stellarcore.org/api" }),
    "https://stellarcore.org/api/corridors",
  );

  // 4. Base URL has nested prefix e.g. /v1/api and target is /api/rates
  assert.equal(
    resolveApiUrl("/api/rates", { baseUrl: "https://stellarcore.org/v1/api" }),
    "https://stellarcore.org/v1/api/rates",
  );

  // 5. Multiple redundant slashes normalized
  assert.equal(
    resolveApiUrl("///api//rates///", { baseUrl: "https://stellarcore.org///" }),
    "https://stellarcore.org/api/rates/",
  );

  // 6. Base URL with non-overlapping pathname
  assert.equal(
    resolveApiUrl("/api/rates", { baseUrl: "https://stellarcore.org/backend" }),
    "https://stellarcore.org/backend/api/rates",
  );
});

test("preserves query parameters and URL hashes exactly", () => {
  const url = resolveApiUrl(
    "/api/rates/history?corridor=usdc-us-brl-br&days=30#evidence-panel",
    { baseUrl: "https://stellarcore.org" },
  );
  assert.equal(
    url,
    "https://stellarcore.org/api/rates/history?corridor=usdc-us-brl-br&days=30#evidence-panel",
  );
});

test("invalid configuration fails clearly and safely without leaking secrets", () => {
  // Empty or non-string paths
  assert.throws(
    () => resolveApiUrl("", { baseUrl: "https://stellarcore.org" }),
    (err: Error) => {
      assert.equal(err instanceof InvalidApiUrlConfigurationError, true);
      assert.match(err.message, /non-empty string/i);
      return true;
    },
  );

  assert.throws(
    // @ts-expect-error test non-string runtime input
    () => resolveApiUrl(null, { baseUrl: "https://stellarcore.org" }),
    InvalidApiUrlConfigurationError,
  );

  // Unsupported protocols
  assert.throws(
    () => resolveApiUrl("/api/rates", { baseUrl: "ftp://files.stellarcore.org" }),
    (err: Error) => {
      assert.equal(err instanceof InvalidApiUrlConfigurationError, true);
      assert.match(err.message, /Unsupported protocol 'ftp:'/i);
      return true;
    },
  );

  assert.throws(
    () => resolveApiUrl("/api/rates", { baseUrl: "javascript:alert(1)" }),
    InvalidApiUrlConfigurationError,
  );

  // Protocol-relative without protocol
  assert.throws(
    () => resolveApiUrl("/api/rates", { baseUrl: "//stellarcore.org" }),
    (err: Error) => {
      assert.equal(err instanceof InvalidApiUrlConfigurationError, true);
      assert.match(err.message, /explicit http or https protocol/i);
      return true;
    },
  );

  // Credentials in base URL (security check: fail clearly without reflecting secret)
  assert.throws(
    () => resolveApiUrl("/api/rates", { baseUrl: "https://admin:super_secret_password@stellarcore.org" }),
    (err: Error) => {
      assert.equal(err instanceof InvalidApiUrlConfigurationError, true);
      assert.match(err.message, /must not contain user credentials/i);
      assert.equal(err.message.includes("super_secret_password"), false);
      return true;
    },
  );

  // Malformed URL
  assert.throws(
    () => resolveApiUrl("/api/rates", { baseUrl: "https://[invalid:host" }),
    InvalidApiUrlConfigurationError,
  );
});

test("dashboard API requests use resolved URL and never contact real production endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const recordedCalls: { url: string; init?: RequestInit }[] = [];

  // Mock fetch to ensure no actual network requests occur
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === "string" ? input : input.toString();
    recordedCalls.push({ url: urlString, init });

    // Ensure test fails loudly if any unmocked call attempts real production egress
    if (urlString.startsWith("https://stellarcore.org") && !recordedCalls) {
      throw new Error("Contacted real production endpoint!");
    }

    return new Response(
      JSON.stringify({ status: 200, data: "mock-response" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    // 1. Dashboard request with local configuration
    const localRes = await fetchDashboardApi(
      "/api/rates/history?corridor=usdc-us-brl-br&days=30",
      undefined,
      { env: { NEXT_PUBLIC_API_URL: "http://localhost:3000" } },
    );
    assert.equal(localRes.status, 200);
    assert.equal(
      recordedCalls[0]?.url,
      "http://localhost:3000/api/rates/history?corridor=usdc-us-brl-br&days=30",
    );

    // 2. Dashboard request with preview configuration
    const previewRes = await fetchDashboardApi(
      "/api/corridors",
      undefined,
      { env: { VERCEL_URL: "stellarcore-preview.vercel.app" } },
    );
    assert.equal(previewRes.status, 200);
    assert.equal(
      recordedCalls[1]?.url,
      "https://stellarcore-preview.vercel.app/api/corridors",
    );

    // 3. Dashboard request with production configuration (prefix deduplication verified)
    const prodRes = await fetchDashboardApi(
      "/api/anchors",
      { headers: { Accept: "application/json" } },
      { baseUrl: "https://stellarcore.org/api" },
    );
    assert.equal(prodRes.status, 200);
    assert.equal(
      recordedCalls[2]?.url,
      "https://stellarcore.org/api/anchors",
    );

    // Verify all 3 mock calls recorded without real network access
    assert.equal(recordedCalls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
