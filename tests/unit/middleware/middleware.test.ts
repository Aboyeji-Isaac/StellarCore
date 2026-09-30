import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function createMockRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

test("middleware adds CSP header to HTML responses", async () => {
  const request = createMockRequest("/dashboard");
  const response = middleware(request);

  assert.ok(response.headers.has("Content-Security-Policy"));
  const csp = response.headers.get("Content-Security-Policy")!;
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("script-src"));
  assert.ok(csp.includes("style-src"));
});

test("middleware adds CSP nonce header", async () => {
  const request = createMockRequest("/dashboard");
  const response = middleware(request);

  assert.ok(response.headers.has("x-csp-nonce"));
  const nonce = response.headers.get("x-csp-nonce")!;
  assert.ok(nonce.length > 0);
  assert.doesNotThrow(() => Buffer.from(nonce, "base64"));
});

test("middleware adds security headers", async () => {
  const request = createMockRequest("/");
  const response = middleware(request);

  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.ok(response.headers.get("Permissions-Policy")?.includes("camera=()"));
  assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  assert.equal(response.headers.get("X-DNS-Prefetch-Control"), "on");
  assert.equal(response.headers.get("X-Permitted-Cross-Domain-Policies"), "none");
});

test("middleware sets csp-nonce cookie for non-API routes", async () => {
  const request = createMockRequest("/dashboard");
  const response = middleware(request);

  const cookies = response.cookies.getAll();
  const nonceCookie = cookies.find((c) => c.name === "csp-nonce");
  assert.ok(nonceCookie);
  assert.equal(nonceCookie.httpOnly, true);
  assert.equal(nonceCookie.sameSite, "strict");
  assert.equal(nonceCookie.path, "/");
});

test("middleware does not set csp-nonce cookie for API routes", async () => {
  const request = createMockRequest("/api/anchors");
  const response = middleware(request);

  const cookies = response.cookies.getAll();
  const nonceCookie = cookies.find((c) => c.name === "csp-nonce");
  assert.ok(!nonceCookie);
});

test("middleware generates unique nonce per request", async () => {
  const request1 = createMockRequest("/");
  const request2 = createMockRequest("/dashboard");

  const response1 = middleware(request1);
  const response2 = middleware(request2);

  const nonce1 = response1.headers.get("x-csp-nonce")!;
  const nonce2 = response2.headers.get("x-csp-nonce")!;

  assert.notEqual(nonce1, nonce2);
});

test("CSP policy includes nonce in script-src", async () => {
  const request = createMockRequest("/");
  const response = middleware(request);

  const csp = response.headers.get("Content-Security-Policy")!;
  const nonce = response.headers.get("x-csp-nonce")!;

  assert.ok(csp.includes(`'nonce-${nonce}'`));
});

test("CSP policy includes nonce in style-src", async () => {
  const request = createMockRequest("/");
  const response = middleware(request);

  const csp = response.headers.get("Content-Security-Policy")!;
  const nonce = response.headers.get("x-csp-nonce")!;

  assert.ok(csp.includes(`'nonce-${nonce}'`));
});

test("CSP policy does not include unsafe-inline", async () => {
  const request = createMockRequest("/");
  const response = middleware(request);

  const csp = response.headers.get("Content-Security-Policy")!;
  assert.ok(!csp.includes("'unsafe-inline'"));
});

test("CSP policy includes upgrade-insecure-requests in production", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const request = createMockRequest("/");
    const response = middleware(request);

    const csp = response.headers.get("Content-Security-Policy")!;
    assert.ok(csp.includes("upgrade-insecure-requests"));
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("CSP policy does not include upgrade-insecure-requests in development", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    const request = createMockRequest("/");
    const response = middleware(request);

    const csp = response.headers.get("Content-Security-Policy")!;
    assert.ok(!csp.includes("upgrade-insecure-requests"));
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("CSP policy includes block-all-mixed-content", async () => {
  const request = createMockRequest("/");
  const response = middleware(request);

  const csp = response.headers.get("Content-Security-Policy")!;
  assert.ok(csp.includes("block-all-mixed-content"));
});