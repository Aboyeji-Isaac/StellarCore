import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCK_DOMAIN,
  LOCK_REGISTRY,
  deriveLockKey,
  lockName,
  resolveKey,
} from "@/lib/scheduled/advisoryLockKey";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("deriveLockKey produces identical output for repeated calls with the same input", () => {
  const name = "refresh:scheduled-refresh:v1:global";
  assert.equal(deriveLockKey(name), deriveLockKey(name));
  assert.equal(typeof deriveLockKey(name), "bigint");
});

test("deriveLockKey output is sensitive to every segment change", () => {
  const base = deriveLockKey("refresh:scheduled-refresh:v1:global");
  assert.notEqual(base, deriveLockKey("Refresh:scheduled-refresh:v1:global")); // case
  assert.notEqual(base, deriveLockKey("refresh:scheduled-refresh:v2:global")); // version
  assert.notEqual(base, deriveLockKey("refresh:scheduled-refresh:v1:anchor")); // resource
  assert.notEqual(base, deriveLockKey("refresh:scheduled_refresh:v1:global")); // underscore vs hyphen
});

// ---------------------------------------------------------------------------
// Signed int8 range — PostgreSQL requires [-2^63, 2^63)
// ---------------------------------------------------------------------------

test("all registry keys fall within signed int8 range", () => {
  const MIN = -(2n ** 63n);
  const MAX = 2n ** 63n - 1n;
  for (const entry of LOCK_REGISTRY) {
    assert.ok(
      entry.derivedKey >= MIN && entry.derivedKey <= MAX,
      `key out of range for ${entry.logicalName}: ${entry.derivedKey}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Collision detection — this test is the build-time gate for Issue #235
// ---------------------------------------------------------------------------

test("LOCK_REGISTRY has zero derived-key collisions across all declared locks", () => {
  const seen = new Map<bigint, string>();
  for (const entry of LOCK_REGISTRY) {
    const existing = seen.get(entry.derivedKey);
    assert.equal(
      existing,
      undefined,
      `Collision: "${entry.logicalName}" and "${existing}" share key ${entry.derivedKey}`,
    );
    seen.set(entry.derivedKey, entry.logicalName);
  }
  assert.equal(seen.size, LOCK_REGISTRY.length);
});

test("LOCK_REGISTRY has no duplicate logical names", () => {
  const names = new Set(LOCK_REGISTRY.map((e) => e.logicalName));
  assert.equal(names.size, LOCK_REGISTRY.length);
});

// ---------------------------------------------------------------------------
// Domain isolation — distinct domain strings produce distinct key spaces
// ---------------------------------------------------------------------------

test("same workflow in different domains produces distinct keys", () => {
  const a = deriveLockKey(lockName("refresh", "global-sync", "v1", "global"));
  const b = deriveLockKey(lockName("migration", "global-sync", "v1", "global"));
  const c = deriveLockKey(lockName("maintenance", "global-sync", "v1", "global"));
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// lockName — segment validation
// ---------------------------------------------------------------------------

test("lockName concatenates segments with colon separators", () => {
  assert.equal(lockName("refresh", "run", "v1", "global"), "refresh:run:v1:global");
});

test("lockName rejects empty segments", () => {
  assert.throws(() => lockName("", "run", "v1", "global"));
  assert.throws(() => lockName("refresh", "", "v1", "global"));
  assert.throws(() => lockName("refresh", "run", "", "global"));
  assert.throws(() => lockName("refresh", "run", "v1", ""));
});

// ---------------------------------------------------------------------------
// Registry integrity — every entry has expected shape and domain membership
// ---------------------------------------------------------------------------

test("every LOCK_REGISTRY entry has a non-empty logicalName, a valid domainId, and a description", () => {
  const validDomains = new Set(Object.values(LOCK_DOMAIN));
  for (const entry of LOCK_REGISTRY) {
    assert.ok(entry.logicalName.length > 0, "logicalName must be non-empty");
    assert.ok(validDomains.has(entry.domainId as (typeof LOCK_DOMAIN)[keyof typeof LOCK_DOMAIN]), `domainId ${entry.domainId} not in LOCK_DOMAIN`);
    assert.ok(entry.description.length > 0, "description must be non-empty");
    // derivedKey must match fresh derivation — detects registry drift
    assert.equal(entry.derivedKey, deriveLockKey(entry.logicalName),
      `derivedKey drift detected for ${entry.logicalName}`);
  }
});

// ---------------------------------------------------------------------------
// resolveKey — reverse mapping
// ---------------------------------------------------------------------------

test("resolveKey returns the matching descriptor for all registry entries", () => {
  for (const entry of LOCK_REGISTRY) {
    const resolved = resolveKey(entry.derivedKey);
    assert.ok(resolved !== undefined);
    assert.equal(resolved.logicalName, entry.logicalName);
  }
});

test("resolveKey returns undefined for an unregistered key", () => {
  assert.equal(resolveKey(0n), undefined);
  assert.equal(resolveKey(-1n), undefined);
  assert.equal(resolveKey(9999999999999999999n), undefined);
});

// ---------------------------------------------------------------------------
// Concrete key spot-checks — detects accidental hash implementation changes
// ---------------------------------------------------------------------------

test("refresh:scheduled-refresh:v1:global derives to its known stable key", () => {
  assert.equal(
    deriveLockKey("refresh:scheduled-refresh:v1:global"),
    432775748742422739n,
  );
});

test("migration:schema-migration:v1:global derives to its known stable key", () => {
  assert.equal(
    deriveLockKey("migration:schema-migration:v1:global"),
    5712893717979117713n,
  );
});
