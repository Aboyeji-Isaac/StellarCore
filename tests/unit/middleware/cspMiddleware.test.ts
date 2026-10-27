import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { middleware } from "@/middleware";

test("middleware emits a nonce-bound CSP and hardened page headers", () => {
  const response = middleware(
    new NextRequest("https://stellarcore.example/dashboard"),
  );

  const csp = response.headers.get("content-security-policy");
  assert.ok(csp);

  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes("'unsafe-inline'"), false);

  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains; preload",
  );

  // NextResponse encodes request-header overrides into these middleware
  // transport headers. x-nonce stays upstream-only rather than being exposed
  // as a normal response header.
  const overridden = response.headers.get("x-middleware-override-headers") ?? "";
  assert.match(overridden, /x-nonce/i);
  assert.equal(response.headers.get("x-nonce"), null);
});

test("middleware creates a different nonce for separate page requests", () => {
  const first = middleware(new NextRequest("https://stellarcore.example/"));
  const second = middleware(
    new NextRequest("https://stellarcore.example/dashboard"),
  );

  const firstNonce = first.headers
    .get("content-security-policy")
    ?.match(/'nonce-([^']+)'/)?.[1];
  const secondNonce = second.headers
    .get("content-security-policy")
    ?.match(/'nonce-([^']+)'/)?.[1];

  assert.ok(firstNonce);
  assert.ok(secondNonce);
  assert.notEqual(firstNonce, secondNonce);
});
