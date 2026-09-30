import assert from "node:assert/strict";
import test from "node:test";

import { RateLimiter } from "@/lib/ratelimit/limiter";
import type { RateLimitPolicy } from "@/lib/ratelimit/policy";
import { MemoryRateLimitStore, type RateLimitStore } from "@/lib/ratelimit/store";

const WINDOW_START = 120_000; // window index 2 covers [120000, 180000)
const POLICY: RateLimitPolicy = {
  group: "catalog",
  limit: 3,
  windowMs: 60_000,
  onStoreFailure: "local_fallback",
};

function clock(start: number) {
  const state = { now: start };
  return { state, now: () => state.now };
}

class FailingStore implements RateLimitStore {
  async hit(): Promise<number> {
    throw new Error("store down");
  }
}

class HangingStore implements RateLimitStore {
  hit(): Promise<number> {
    return new Promise<number>(() => {});
  }
}

class InvalidStore implements RateLimitStore {
  async hit(): Promise<number> {
    return Number.NaN;
  }
}

test("threshold boundary: limit requests pass, the next is limited", async () => {
  const c = clock(WINDOW_START + 10_000);
  const limiter = new RateLimiter({ store: new MemoryRateLimitStore(c.now), now: c.now });

  for (let i = 1; i <= 3; i += 1) {
    const decision = await limiter.check(POLICY, "client");
    assert.equal(decision.outcome, "allowed");
    assert.equal(decision.remaining, 3 - i);
    assert.equal(decision.degraded, false);
  }

  const limited = await limiter.check(POLICY, "client");
  assert.equal(limited.outcome, "limited");
  assert.equal(limited.remaining, 0);
  assert.equal(limited.retryAfterSeconds, 50);
});

test("window rollover resets the budget exactly at the boundary", async () => {
  const c = clock(WINDOW_START);
  const limiter = new RateLimiter({ store: new MemoryRateLimitStore(c.now), now: c.now });

  for (let i = 0; i < 3; i += 1) await limiter.check(POLICY, "client");
  c.state.now = WINDOW_START + 59_999;
  const last = await limiter.check(POLICY, "client");
  assert.equal(last.outcome, "limited");
  assert.equal(last.retryAfterSeconds, 1);

  c.state.now = WINDOW_START + 60_000;
  const next = await limiter.check(POLICY, "client");
  assert.equal(next.outcome, "allowed");
  assert.equal(next.remaining, 2);
});

test("clients and groups have independent budgets", async () => {
  const c = clock(WINDOW_START);
  const limiter = new RateLimiter({ store: new MemoryRateLimitStore(c.now), now: c.now });

  for (let i = 0; i < 4; i += 1) await limiter.check(POLICY, "a");
  assert.equal((await limiter.check(POLICY, "a")).outcome, "limited");
  assert.equal((await limiter.check(POLICY, "b")).outcome, "allowed");
  assert.equal(
    (await limiter.check({ ...POLICY, group: "rates" }, "a")).outcome,
    "allowed",
  );
});

test("concurrent requests never exceed the budget", async () => {
  const c = clock(WINDOW_START);
  const limiter = new RateLimiter({
    store: new MemoryRateLimitStore(c.now),
    now: c.now,
  });
  const policy = { ...POLICY, limit: 5 };

  const decisions = await Promise.all(
    Array.from({ length: 25 }, () => limiter.check(policy, "burst")),
  );

  assert.equal(decisions.filter((d) => d.outcome === "allowed").length, 5);
  assert.equal(decisions.filter((d) => d.outcome === "limited").length, 20);
});

test("counters are shared through the store, not process-local", async () => {
  const c = clock(WINDOW_START);
  const shared = new MemoryRateLimitStore(c.now);
  const instanceA = new RateLimiter({ store: shared, now: c.now });
  const instanceB = new RateLimiter({ store: shared, now: c.now });

  await instanceA.check(POLICY, "client");
  await instanceB.check(POLICY, "client");
  await instanceA.check(POLICY, "client");

  assert.equal((await instanceB.check(POLICY, "client")).outcome, "limited");
  assert.equal((await instanceA.check(POLICY, "client")).outcome, "limited");
});

test("store failure with local_fallback stays bounded and is marked degraded", async () => {
  const c = clock(WINDOW_START);
  const limiter = new RateLimiter({ store: new FailingStore(), now: c.now });

  for (let i = 0; i < 3; i += 1) {
    const decision = await limiter.check(POLICY, "client");
    assert.equal(decision.outcome, "allowed");
    assert.equal(decision.degraded, true);
  }
  const limited = await limiter.check(POLICY, "client");
  assert.equal(limited.outcome, "limited");
  assert.equal(limited.degraded, true);
});

test("store failure with deny policy reports unavailable", async () => {
  const c = clock(WINDOW_START);
  const limiter = new RateLimiter({ store: new FailingStore(), now: c.now });
  const decision = await limiter.check({ ...POLICY, onStoreFailure: "deny" }, "client");

  assert.equal(decision.outcome, "unavailable");
  assert.equal(decision.retryAfterSeconds, 5);
});

test("a hanging or invalid store is treated as a failure", async () => {
  const c = clock(WINDOW_START);
  const hanging = new RateLimiter({
    store: new HangingStore(),
    now: c.now,
    storeTimeoutMs: 10,
  });
  const invalid = new RateLimiter({ store: new InvalidStore(), now: c.now });

  assert.equal((await hanging.check(POLICY, "client")).degraded, true);
  assert.equal((await invalid.check(POLICY, "client")).degraded, true);
});
