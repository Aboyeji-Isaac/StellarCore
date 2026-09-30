import assert from "node:assert/strict";
import test from "node:test";

import { generateNonce, buildCspPolicy, buildSecurityHeaders, isApiRoute } from "@/middleware";

test("generateNonce produces a valid base64 string", () => {
  const nonce = generateNonce();
  assert.ok(typeof nonce === "string");
  assert.ok(nonce.length > 0);
  assert.doesNotThrow(() => Buffer.from(nonce, "base64"));
});

test("generateNonce produces different values on each call", () => {
  const nonce1 = generateNonce();
  const nonce2 = generateNonce();
  assert.notEqual(nonce1, nonce2);
});

test("buildCspPolicy includes required directives in production", () => {
  const nonce = "test-nonce-123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("default-src 'self'"));
  assert.ok(policy.includes(`script-src 'self' 'strict-dynamic' 'nonce-${nonce}'`));
  assert.ok(policy.includes(`style-src 'self' 'nonce-${nonce}'`));
  assert.ok(policy.includes("img-src 'self' data: blob:"));
  assert.ok(policy.includes("font-src 'self' data:"));
  assert.ok(policy.includes("connect-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("base-uri 'self'"));
  assert.ok(policy.includes("form-action 'self'"));
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(policy.includes("upgrade-insecure-requests"));
  assert.ok(policy.includes("block-all-mixed-content"));
  assert.ok(!policy.includes("'unsafe-eval'"));
  assert.ok(!policy.includes("'unsafe-inline'"));
});

test("buildCspPolicy includes unsafe-eval in development", () => {
  const nonce = "test-nonce-123";
  const policy = buildCspPolicy(nonce, true);

  assert.ok(policy.includes("'unsafe-eval'"));
});

test("buildSecurityHeaders returns all required headers", () => {
  const nonce = "test-nonce-123";
  const headers = buildSecurityHeaders(nonce, false);

  assert.equal(headers["Content-Security-Policy"], buildCspPolicy(nonce, false));
  assert.equal(headers["x-csp-nonce"], nonce);
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.ok(headers["Permissions-Policy"].includes("accelerometer=()"));
  assert.ok(headers["Permissions-Policy"].includes("camera=()"));
  assert.ok(headers["Permissions-Policy"].includes("geolocation=()"));
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(headers["X-DNS-Prefetch-Control"], "on");
  assert.equal(headers["X-Permitted-Cross-Domain-Policies"], "none");
});

test("isApiRoute identifies API routes correctly", () => {
  assert.equal(isApiRoute("/api/anchors"), true);
  assert.equal(isApiRoute("/api/anchors/zeam"), true);
  assert.equal(isApiRoute("/api/internal/cron/refresh"), true);
  assert.equal(isApiRoute("/dashboard"), false);
  assert.equal(isApiRoute("/"), false);
  assert.equal(isApiRoute("/corridors/usdc-us-brl-br"), false);
});

test("CSP policy uses nonce for script-src and style-src", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  const scriptSrcMatch = policy.match(/script-src ([^;]+)/);
  const styleSrcMatch = policy.match(/style-src ([^;]+)/);

  assert.ok(scriptSrcMatch);
  assert.ok(scriptSrcMatch![1].includes(`'nonce-${nonce}'`));

  assert.ok(styleSrcMatch);
  assert.ok(styleSrcMatch![1].includes(`'nonce-${nonce}'`));
});

test("CSP policy does not contain unsafe-inline", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(!policy.includes("'unsafe-inline'"));
});

test("CSP policy includes strict-dynamic for script-src", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("'strict-dynamic'"));
});

test("CSP policy restricts frame-ancestors to none", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("frame-ancestors 'none'"));
});

test("CSP policy restricts object-src to none", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("object-src 'none'"));
});

test("CSP policy includes base-uri self", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("base-uri 'self'"));
});

test("CSP policy includes form-action self", () => {
  const nonce = "abc123";
  const policy = buildCspPolicy(nonce, false);

  assert.ok(policy.includes("form-action 'self'"));
});