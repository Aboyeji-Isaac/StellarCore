import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as rateHistoryRoute from "@/app/api/rates/history/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import { middleware } from "@/middleware";
import { publicApiJsonResponse } from "@/lib/api/http";
import { publicApiErrorResult } from "@/lib/api/errors";
import { createRateLimiter } from "@/lib/api/rateLimiter";
import {
  generateRequestId,
  isValidRequestId,
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  resolveRequestId,
} from "@/lib/security/requestId";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("request ID validator and resolver preserve valid IDs and reject unsafe inputs", () => {
  const validUuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  assert.equal(isValidRequestId(validUuid), true);
  assert.equal(resolveRequestId(validUuid), validUuid);

  const customValidId = "client-trace-123.456_ABC:01";
  assert.equal(isValidRequestId(customValidId), true);
  assert.equal(resolveRequestId(customValidId), customValidId);

  // Rejection of injection attacks, control chars, spaces, and html tags
  const unsafeInputs = [
    "",
    "   ",
    "id\r\nX-Injected: value",
    "id\nInjected: value",
    "<script>alert(1)</script>",
    "id-with space",
    "id'OR'1'='1",
    'id"quote',
    "id\0nullbyte",
    "a".repeat(MAX_REQUEST_ID_LENGTH + 1),
  ];

  for (const unsafe of unsafeInputs) {
    assert.equal(isValidRequestId(unsafe), false);
    const resolved = resolveRequestId(unsafe);
    assert.match(resolved, UUID_V4_PATTERN);
    assert.match(resolved, REQUEST_ID_PATTERN);
    assert.notEqual(resolved, unsafe);
  }

  // Null and undefined resolve to fresh safe UUIDs
  assert.equal(isValidRequestId(null), false);
  assert.equal(isValidRequestId(undefined), false);
  assert.match(resolveRequestId(null), UUID_V4_PATTERN);
  assert.match(resolveRequestId(undefined), UUID_V4_PATTERN);

  // Generated IDs use cryptographically strong UUIDv4
  const generated = generateRequestId();
  assert.match(generated, UUID_V4_PATTERN);
  assert.equal(isValidRequestId(generated), true);
});

test("validation errors (400) follow request-ID contract across public routes", async () => {
  const validRequestId = "req-validation-test-001";
  const routes = [
    {
      name: "rates (missing corridor)",
      exec: () =>
        ratesRoute.GET(
          new Request("http://localhost/api/rates", {
            headers: { [REQUEST_ID_HEADER]: validRequestId },
          }),
        ),
    },
    {
      name: "rates (invalid corridor slug)",
      exec: () =>
        ratesRoute.GET(
          new Request("http://localhost/api/rates?corridor=bad--slug", {
            headers: { [REQUEST_ID_HEADER]: validRequestId },
          }),
        ),
    },
    {
      name: "rate history (invalid days query)",
      exec: () =>
        rateHistoryRoute.GET(
          new Request(
            "http://localhost/api/rates/history?corridor=usdc-us-brl-br&days=invalid",
            {
              headers: { [REQUEST_ID_HEADER]: validRequestId },
            },
          ),
        ),
    },
    {
      name: "anchor detail (invalid slug)",
      exec: () =>
        anchorDetailRoute.GET(
          new Request("http://localhost/api/anchors/bad--slug", {
            headers: { [REQUEST_ID_HEADER]: validRequestId },
          }),
          { params: Promise.resolve({ slug: "bad--slug" }) },
        ),
    },
    {
      name: "corridor detail (invalid slug)",
      exec: () =>
        corridorDetailRoute.GET(
          new Request("http://localhost/api/corridors/bad--slug", {
            headers: { [REQUEST_ID_HEADER]: validRequestId },
          }),
          { params: Promise.resolve({ slug: "bad--slug" }) },
        ),
    },
    {
      name: "reputation detail (invalid slug)",
      exec: () =>
        reputationDetailRoute.GET(
          new Request("http://localhost/api/reputation/bad--slug", {
            headers: { [REQUEST_ID_HEADER]: validRequestId },
          }),
          { params: Promise.resolve({ slug: "bad--slug" }) },
        ),
    },
  ];

  for (const { name, exec } of routes) {
    const response = await exec();
    assert.equal(response.status, 400, `Expected 400 for ${name}`);
    assert.equal(
      response.headers.get(REQUEST_ID_HEADER),
      validRequestId,
      `Expected preserved request ID header for ${name}`,
    );

    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
    assert.ok(body.error.code.length > 0);
    assert.ok(body.error.message.length > 0);
  }
});

test("missing resources (404) follow request-ID contract and preserve valid incoming ID", async () => {
  const validRequestId = "req-missing-resource-002";

  // 1. Missing anchor entity
  const mockAnchorRepo = {
    findAll: async () => [],
    findBySlug: async () => null,
  };
  const anchorResponse = await anchorDetailRoute.GET(
    new Request("http://localhost/api/anchors/nonexistent-anchor", {
      headers: { [REQUEST_ID_HEADER]: validRequestId },
    }),
    { params: Promise.resolve({ slug: "nonexistent-anchor" }) },
    { repository: mockAnchorRepo },
  );
  assert.equal(anchorResponse.status, 404);
  assert.equal(anchorResponse.headers.get(REQUEST_ID_HEADER), validRequestId);
  const anchorBody = (await anchorResponse.json()) as { error: { code: string; message: string } };
  assert.deepEqual(anchorBody, {
    error: { code: "anchor_not_found", message: "Anchor not found." },
  });

  // 2. Missing corridor entity
  const mockCorridorRepo = {
    findAll: async () => [],
    findBySlug: async () => null,
  };
  const corridorResponse = await corridorDetailRoute.GET(
    new Request("http://localhost/api/corridors/nonexistent-corridor", {
      headers: { [REQUEST_ID_HEADER]: validRequestId },
    }),
    { params: Promise.resolve({ slug: "nonexistent-corridor" }) },
    { repository: mockCorridorRepo },
  );
  assert.equal(corridorResponse.status, 404);
  assert.equal(corridorResponse.headers.get(REQUEST_ID_HEADER), validRequestId);
  const corridorBody = (await corridorResponse.json()) as { error: { code: string; message: string } };
  assert.deepEqual(corridorBody, {
    error: { code: "corridor_not_found", message: "Corridor not found." },
  });

  // 3. Missing API route intercepted at middleware boundary
  const missingRouteReq = new NextRequest("http://localhost/api/nonexistent-endpoint", {
    headers: { [REQUEST_ID_HEADER]: validRequestId },
  });
  const middlewareResponse = middleware(missingRouteReq);
  assert.equal(middlewareResponse.headers.get(REQUEST_ID_HEADER), validRequestId);
});

test("database failures (500) follow request-ID contract without leaking secrets or internals", async () => {
  const validRequestId = "req-db-failure-003";
  const dbSecretUrl =
    "postgresql://superuser:p%40ssw0rd!@10.0.1.99:5432/production?sslmode=require";

  // Simulate repository/DB failure via publicApiErrorResult & publicApiJsonResponse
  const errorResult = publicApiErrorResult("internal_error", "Unable to load anchors.");

  const request = new Request("http://localhost/api/anchors", {
    headers: { [REQUEST_ID_HEADER]: validRequestId },
  });

  const response = publicApiJsonResponse(errorResult, {}, request);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get(REQUEST_ID_HEADER), validRequestId);

  const rawJson = await response.text();
  assert.equal(rawJson.includes(dbSecretUrl), false);

  const parsed = JSON.parse(rawJson);
  assert.deepEqual(parsed, {
    error: { code: "internal_error", message: "Unable to load anchors." },
  });
});

test("unexpected exceptions in routes are caught and follow request-ID contract", async () => {
  const validRequestId = "req-unexpected-004";

  // Pass an object that causes an unexpected error when accessing params
  const faultingContext = {
    get params(): Promise<{ slug: string }> {
      throw new TypeError("Simulated unexpected runtime crash inside route handler");
    },
  };

  const response = await anchorDetailRoute.GET(
    new Request("http://localhost/api/anchors/test-slug", {
      headers: { [REQUEST_ID_HEADER]: validRequestId },
    }),
    faultingContext,
  );

  assert.equal(response.status, 500);
  assert.equal(response.headers.get(REQUEST_ID_HEADER), validRequestId);

  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.deepEqual(body, {
    error: { code: "internal_error", message: "Unable to load anchors." },
  });
  assert.equal(JSON.stringify(body).includes("Simulated unexpected"), false);
});

test("rate limiter (429) preserves incoming valid request ID and formats contract", async () => {
  const validRequestId = "req-ratelimit-005";
  const limiter = createRateLimiter(1, 60_000);

  const req1 = new Request("http://localhost/api/rates", {
    headers: {
      "x-forwarded-for": "198.51.100.1",
      [REQUEST_ID_HEADER]: validRequestId,
    },
  });
  const first = await limiter.check(req1, Date.now());
  assert.equal(first.allowed, true);

  const req2 = new Request("http://localhost/api/rates", {
    headers: {
      "x-forwarded-for": "198.51.100.1",
      [REQUEST_ID_HEADER]: validRequestId,
    },
  });
  const second = await limiter.check(req2, Date.now());
  assert.equal(second.allowed, false);

  if (!second.allowed) {
    assert.equal(second.response.status, 429);
    assert.equal(second.response.headers.get(REQUEST_ID_HEADER), validRequestId);
    const body = await second.response.json();
    assert.deepEqual(body, {
      error: {
        code: "rate_limited",
        message: "Too many requests. Please try again later.",
      },
    });
  }
});

test("unsafe user-controlled request IDs are replaced with fresh safe IDs across error paths", async () => {
  const unsafeHeaders = [
    "<script>alert(1)</script>",
    "id-with space",
    "id'OR'1'='1",
    'id"quote',
    "a".repeat(MAX_REQUEST_ID_LENGTH + 1),
  ];

  for (const maliciousHeader of unsafeHeaders) {
    const req = new Request("http://localhost/api/rates?corridor=bad--slug", {
      headers: { [REQUEST_ID_HEADER]: maliciousHeader },
    });

    const response = await ratesRoute.GET(req);
    assert.equal(response.status, 400);

    const returnedId = response.headers.get(REQUEST_ID_HEADER);
    assert.ok(returnedId);
    assert.notEqual(returnedId, maliciousHeader);
    assert.equal(returnedId.includes("<script>"), false);
    assert.equal(returnedId.includes(" "), false);
    assert.equal(returnedId.includes("'"), false);
    assert.match(returnedId, UUID_V4_PATTERN);
    assert.match(returnedId, REQUEST_ID_PATTERN);
  }
});

test("middleware attaches request ID for both API and browser requests without leaking CSP to API", () => {
  const validId = "req-middleware-test-006";

  // 1. API request through middleware
  const apiReq = new NextRequest("https://stellarcore.example/api/corridors", {
    headers: { [REQUEST_ID_HEADER]: validId },
  });
  const apiRes = middleware(apiReq);
  assert.equal(apiRes.headers.get(REQUEST_ID_HEADER), validId);
  // API responses must not receive browser page CSP
  assert.equal(apiRes.headers.get("content-security-policy"), null);

  // 2. Browser page request through middleware
  const pageReq = new NextRequest("https://stellarcore.example/dashboard", {
    headers: { [REQUEST_ID_HEADER]: validId },
  });
  const pageRes = middleware(pageReq);
  assert.equal(pageRes.headers.get(REQUEST_ID_HEADER), validId);
  assert.ok(pageRes.headers.get("content-security-policy"));
  assert.equal(pageRes.headers.get("x-frame-options"), "DENY");

  // 3. API request with missing request ID receives a fresh safe UUID
  const apiReqWithoutId = new NextRequest("https://stellarcore.example/api/anchors");
  const apiResWithoutId = middleware(apiReqWithoutId);
  const generatedId = apiResWithoutId.headers.get(REQUEST_ID_HEADER);
  assert.ok(generatedId);
  assert.match(generatedId, UUID_V4_PATTERN);
});
