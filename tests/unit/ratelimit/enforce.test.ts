import assert from "node:assert/strict";
import test from "node:test";

import { enforcePublicRateLimit, type EnforceDependencies } from "@/lib/ratelimit/enforce";
import { RateLimiter } from "@/lib/ratelimit/limiter";
import { groupForPath, loadRateLimitConfig } from "@/lib/ratelimit/policy";
import {
  MemoryRateLimitStore,
  RedisRestRateLimitStore,
  type RateLimitStore,
} from "@/lib/ratelimit/store";

const NOW = 1_800_000_000_000;
const HEADER = "x-vercel-forwarded-for";

function dependencies(
  env: Record<string, string> = {},
  store?: RateLimitStore,
): EnforceDependencies {
  const now = () => NOW;
  return {
    config: loadRateLimitConfig({
      RATE_LIMIT_CATALOG_PER_MINUTE: "2",
      RATE_LIMIT_RATES_PER_MINUTE: "1",
      ...env,
    }),
    limiter: new RateLimiter({ store: store ?? new MemoryRateLimitStore(now), now }),
  };
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://stellarcore.example${path}`, { headers });
}

test("requests below the threshold are admitted untouched", async () => {
  const deps = dependencies();
  const headers = { [HEADER]: "203.0.113.7" };

  assert.equal(await enforcePublicRateLimit(request("/api/anchors", headers), deps), undefined);
  assert.equal(await enforcePublicRateLimit(request("/api/anchors", headers), deps), undefined);
});

test("over-budget requests get a stable, bounded 429 with Retry-After", async () => {
  const deps = dependencies();
  const headers = { [HEADER]: "203.0.113.7" };
  await enforcePublicRateLimit(request("/api/anchors", headers), deps);
  await enforcePublicRateLimit(request("/api/anchors", headers), deps);

  const response = await enforcePublicRateLimit(request("/api/anchors", headers), deps);

  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const retryAfter = Number(response.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);
  assert.deepEqual(await response.json(), {
    error: {
      code: "rate_limited",
      message: "Too many requests. Retry later.",
      retryAfterSeconds: retryAfter,
    },
  });
});

test("internal cron and non-API paths are never throttled", async () => {
  const deps = dependencies();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(
      await enforcePublicRateLimit(request("/api/internal/cron/refresh"), deps),
      undefined,
    );
    assert.equal(await enforcePublicRateLimit(request("/dashboard"), deps), undefined);
  }
  assert.equal(groupForPath("/api/internal"), null);
  assert.equal(groupForPath("/api/internal/cron/refresh"), null);
});

test("route groups and clients are budgeted independently", async () => {
  const deps = dependencies();
  const a = { [HEADER]: "203.0.113.7" };
  const b = { [HEADER]: "203.0.113.8" };

  assert.equal(await enforcePublicRateLimit(request("/api/rates?corridor=x", a), deps), undefined);
  assert.equal((await enforcePublicRateLimit(request("/api/rates?corridor=x", a), deps))?.status, 429);
  assert.equal(await enforcePublicRateLimit(request("/api/anchors", a), deps), undefined);
  assert.equal(await enforcePublicRateLimit(request("/api/rates?corridor=x", b), deps), undefined);
});

test("spoofed or malformed forwarding headers cannot mint new identities", async () => {
  const deps = dependencies();

  // Untrusted headers are ignored entirely: everything shares one bucket.
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      await enforcePublicRateLimit(
        request("/api/anchors", { "x-forwarded-for": `198.51.100.${i}` }),
        deps,
      ),
      undefined,
    );
  }
  assert.equal(
    (await enforcePublicRateLimit(
      request("/api/anchors", { "x-forwarded-for": "198.51.100.99" }),
      deps,
    ))?.status,
    429,
  );

  // Malformed values in the trusted header also collapse into one bucket.
  const other = dependencies();
  for (const value of ["junk-1", "1.2.3.4.5", "999.9.9.9"]) {
    const response = await enforcePublicRateLimit(
      request("/api/corridors", { [HEADER]: value }),
      other,
    );
    if (value === "999.9.9.9") assert.equal(response?.status, 429);
  }
});

test("store outage falls back to bounded per-instance limits and admits below budget", async () => {
  const failing: RateLimitStore = {
    async hit() {
      throw new Error("down");
    },
  };
  const deps = dependencies({}, failing);
  const headers = { [HEADER]: "203.0.113.7" };

  assert.equal(await enforcePublicRateLimit(request("/api/anchors", headers), deps), undefined);
  assert.equal(await enforcePublicRateLimit(request("/api/anchors", headers), deps), undefined);
  assert.equal((await enforcePublicRateLimit(request("/api/anchors", headers), deps))?.status, 429);
});

test("deny policy returns 503 with Retry-After when the store is down", async () => {
  const failing: RateLimitStore = {
    async hit() {
      throw new Error("down");
    },
  };
  const base = dependencies({}, failing);
  const deps: EnforceDependencies = {
    ...base,
    config: {
      ...base.config,
      policies: {
        ...base.config.policies,
        catalog: { ...base.config.policies.catalog, onStoreFailure: "deny" },
      },
    },
  };

  const response = await enforcePublicRateLimit(request("/api/anchors"), deps);

  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("retry-after"), "5");
  const body = (await response?.json()) as { error: { code: string } };
  assert.equal(body.error.code, "rate_limiter_unavailable");
});

test("configuration ignores invalid values and never accepts an insecure store", () => {
  const defaults = loadRateLimitConfig({});
  assert.equal(defaults.policies.catalog.limit, 120);
  assert.equal(defaults.policies.rates.limit, 60);
  assert.equal(defaults.trustedIpHeader, "x-vercel-forwarded-for");
  assert.equal(defaults.store, null);

  const bad = loadRateLimitConfig({
    RATE_LIMIT_CATALOG_PER_MINUTE: "-5",
    RATE_LIMIT_RATES_PER_MINUTE: "abc",
    RATE_LIMIT_TRUSTED_IP_HEADER: "bad header!",
    RATE_LIMIT_REDIS_REST_URL: "http://insecure.example",
    RATE_LIMIT_REDIS_REST_TOKEN: "token",
  });
  assert.equal(bad.policies.catalog.limit, 120);
  assert.equal(bad.policies.rates.limit, 60);
  assert.equal(bad.trustedIpHeader, "x-vercel-forwarded-for");
  assert.equal(bad.store, null);

  const good = loadRateLimitConfig({
    RATE_LIMIT_REDIS_REST_URL: "https://store.example/",
    RATE_LIMIT_REDIS_REST_TOKEN: "token",
  });
  assert.equal(good.store?.url, "https://store.example");
});

test("redis REST store sends an atomic INCR+PEXPIRE pipeline and validates replies", async () => {
  let seen: { url: string; auth: string | null; body: unknown } | undefined;
  const okFetch = (async (input: unknown, init?: RequestInit) => {
    seen = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    return Response.json([{ result: 4 }, { result: 1 }]);
  }) as typeof fetch;

  const store = new RedisRestRateLimitStore({
    url: "https://store.example",
    token: "sekret-token",
    fetcher: okFetch,
  });
  assert.equal(await store.hit("rl:v1:catalog:abc:1", 60_000), 4);
  assert.equal(seen?.url, "https://store.example/pipeline");
  assert.equal(seen?.auth, "Bearer sekret-token");
  assert.deepEqual(seen?.body, [
    ["INCR", "rl:v1:catalog:abc:1"],
    ["PEXPIRE", "rl:v1:catalog:abc:1", "120000"],
  ]);

  for (const reply of [
    new Response("nope", { status: 500 }),
    Response.json({ unexpected: true }),
    Response.json([{ result: "x" }]),
    Response.json([{ error: "ERR" }]),
  ]) {
    const badStore = new RedisRestRateLimitStore({
      url: "https://store.example",
      token: "sekret-token",
      fetcher: (async () => reply.clone()) as typeof fetch,
    });
    await assert.rejects(
      badStore.hit("k", 60_000),
      (error) => error instanceof Error && !error.message.includes("sekret-token"),
    );
  }
});
