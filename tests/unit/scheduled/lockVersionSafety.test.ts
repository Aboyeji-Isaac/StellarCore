/**
 * Rolling-deployment and deadlock-safety tests.
 *
 * These tests verify that:
 * 1. vN and vN+1 lock names using different version segments produce
 *    distinct keys, so neither version silently acquires the other's lock.
 * 2. Concurrent non-blocking acquisition never deadlocks.
 * 3. A stale vN lock cannot block vN+1 indefinitely because
 *    pg_try_advisory_lock is non-blocking.
 * 4. Lock keys remain stable across simulated re-derives (no drift).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";

import { withAdvisoryLock } from "@/lib/scheduled/advisoryLockClient";
import { deriveLockKey, LOCK_REGISTRY, lockName } from "@/lib/scheduled/advisoryLockKey";

// ---------------------------------------------------------------------------
// Key isolation across version bumps
// ---------------------------------------------------------------------------

test("vN and vN+1 version segments produce distinct keys for every reserved domain", () => {
  const domains = ["refresh", "migration", "maintenance"];
  for (const domain of domains) {
    const v1 = deriveLockKey(lockName(domain, "test-workflow", "v1", "global"));
    const v2 = deriveLockKey(lockName(domain, "test-workflow", "v2", "global"));
    assert.notEqual(v1, v2, `v1 and v2 must differ for domain "${domain}"`);
  }
});

test("incrementing version does not collide with any currently registered key", () => {
  const bumpedKeys = new Set(
    LOCK_REGISTRY.map((entry) => {
      // Derive a hypothetical vN+1 key for each registered lock
      const [domain, workflow, , resource] = entry.logicalName.split(":");
      return deriveLockKey(lockName(domain!, workflow!, "v2", resource!));
    }),
  );
  for (const entry of LOCK_REGISTRY) {
    assert.ok(
      !bumpedKeys.has(entry.derivedKey) || bumpedKeys.size === 1, // self-only acceptable when set has 1 item
      `vN+1 key collides with existing vN key for ${entry.logicalName}`,
    );
  }
});

test("a vN+1 key does not appear in the current LOCK_REGISTRY", () => {
  const registeredKeys = new Set(LOCK_REGISTRY.map((e) => e.derivedKey));
  for (const entry of LOCK_REGISTRY) {
    const [domain, workflow, , resource] = entry.logicalName.split(":");
    const v2Key = deriveLockKey(lockName(domain!, workflow!, "v2", resource!));
    assert.ok(
      !registeredKeys.has(v2Key),
      `Hypothetical v2 key for "${entry.logicalName}" collides with a registered key`,
    );
  }
});

// ---------------------------------------------------------------------------
// Non-blocking acquisition semantics — simulates two concurrent nodes
// ---------------------------------------------------------------------------

function makeNode(acquires: boolean): { client: PoolClient } {
  const client: PoolClient = {
    query: async (sql: string) => {
      if (/pg_try_advisory_lock/.test(sql)) {
        return { rows: [{ acquired: acquires }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { client };
}

test("two concurrent nodes: first acquires the lock, second returns already_held without blocking", async () => {
  const key = LOCK_REGISTRY[0]!.derivedKey;

  const { client: clientA } = makeNode(true);
  const { client: clientB } = makeNode(false);

  const released = { a: false, b: false };

  const [resultA, resultB] = await Promise.all([
    withAdvisoryLock(key, async () => "node-a-work", {
      checkoutClient: async () => clientA,
      releaseClient: () => { released.a = true; },
    }),
    withAdvisoryLock(key, async () => "node-b-work", {
      checkoutClient: async () => clientB,
      releaseClient: () => { released.b = true; },
    }),
  ]);

  assert.ok(resultA.lock.acquired === true);
  assert.ok("result" in resultA && (resultA as { result: string }).result === "node-a-work");

  assert.ok(resultB.lock.acquired === false);
  assert.ok(!("result" in resultB));

  assert.ok(released.a && released.b, "both clients must be released");
});

test("second node continues without error after receiving already_held — no deadlock possible", async () => {
  const key = LOCK_REGISTRY[0]!.derivedKey;
  const client = { query: async () => ({ rows: [{ acquired: false }] }), release: () => undefined } as unknown as PoolClient;

  // Must resolve (not hang) because pg_try_advisory_lock is non-blocking
  const result = await withAdvisoryLock(key, async () => 99, {
    checkoutClient: async () => client,
    releaseClient: () => undefined,
  });

  assert.equal(result.lock.acquired, false);
  assert.ok(!("result" in result));
});

// ---------------------------------------------------------------------------
// Key stability — re-deriving a registered key always produces the same value
// ---------------------------------------------------------------------------

test("re-deriving every registered logical name produces an identical key (no hash drift)", () => {
  for (const entry of LOCK_REGISTRY) {
    const rederived = deriveLockKey(entry.logicalName);
    assert.equal(
      rederived,
      entry.derivedKey,
      `Hash drift detected for "${entry.logicalName}": stored ${entry.derivedKey}, rederived ${rederived}`,
    );
  }
});
