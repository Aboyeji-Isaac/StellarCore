import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBrowserSecurityHeaders,
  buildContentSecurityPolicy,
  generateCspNonce,
} from "@/lib/security/browserHeaders";

test("CSP nonces are fresh and contain only source-safe characters", () => {
  const first = generateCspNonce();
  const second = generateCspNonce();

  assert.match(first, /^[A-Za-z0-9]+$/);
  assert.equal(first.length >= 24, true);
  assert.notEqual(first, second);
});

test("production CSP is nonce-based and contains no inline/eval allowance", () => {
  const nonce = "abc123";
  const policy = buildContentSecurityPolicy(nonce, false);

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, new RegExp(`script-src [^;]*'nonce-${nonce}'`));
  assert.match(policy, /script-src [^;]*'strict-dynamic'/);
  assert.match(policy, new RegExp(`style-src [^;]*'nonce-${nonce}'`));
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.equal(policy.includes("'unsafe-eval'"), false);
  assert.equal(policy.includes("'unsafe-inline'"), false);
});

test("development allowances are limited to tooling needs", () => {
  const policy = buildContentSecurityPolicy("abc123", true);

  assert.match(policy, /script-src [^;]*'unsafe-eval'/);
  assert.match(policy, /style-src [^;]*'unsafe-inline'/);
  assert.match(policy, /connect-src 'self' ws: wss:/);
  assert.equal(policy.includes("upgrade-insecure-requests"), false);
});

test("production browser security headers include transport and browser hardening", () => {
  const headers = buildBrowserSecurityHeaders("abc123", false);

  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(
    headers["Referrer-Policy"],
    "strict-origin-when-cross-origin",
  );
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(headers["X-DNS-Prefetch-Control"], "off");
  assert.equal(
    headers["Strict-Transport-Security"],
    "max-age=63072000; includeSubDomains; preload",
  );
  assert.match(headers["Permissions-Policy"] ?? "", /camera=()/);
  assert.match(headers["Permissions-Policy"] ?? "", /microphone=()/);
  assert.match(headers["Permissions-Policy"] ?? "", /geolocation=()/);
});

test("development omits HSTS", () => {
  const headers = buildBrowserSecurityHeaders("abc123", true);
  assert.equal(headers["Strict-Transport-Security"], undefined);
});
