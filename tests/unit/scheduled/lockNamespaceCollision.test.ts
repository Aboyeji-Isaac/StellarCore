/**
 * Advisory-lock namespace collision regression tests (Issue #349).
 *
 * PostgreSQL advisory locks are identified only by their 64-bit key. Two
 * logical lock names that derive the same key would therefore serialize each
 * other silently. These tests enforce the registry contract:
 *
 * - every declared logical lock name is unique;
 * - every derived key is unique across all declared domains;
 * - the FNV-1a key derivation is pinned by an explicit fixture so a key-version
 *   or algorithm change is a deliberate, reviewable edit;
 * - failures name both conflicting logical names.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCK_DOMAIN,
  LOCK_REGISTRY,
  deriveLockKey,
  lockName,
  resolveKey,
} from "@/lib/scheduled/advisoryLockKey";

/**
 * Pinned key fixture for the current lock-key version (v1).
 *
 * Changing the derivation algorithm, a logical name, or a version segment
 * changes these values. Update this table only with a reviewed key-version
 * migration, because deployed nodes must agree on the same keys.
 */
const PINNED_KEYS_V1: readonly Readonly<{ logicalName: string; key: string }>[] = Object.freeze([
  Object.freeze({ logicalName: "refresh:scheduled-refresh:v1:global", key: "432775748742422739" }),
  Object.freeze({ logicalName: "migration:schema-migration:v1:global", key: "5712893717979117713" }),
  Object.freeze({ logicalName: "maintenance:registry-bootstrap:v1:global", key: "5844646091915520822" }),
  Object.freeze({ logicalName: "maintenance:reputation-backfill:v1:global", key: "-2974118469127250590" }),
]);

/** Declared domains, derived from the registry rather than hand-maintained. */
const DOMAINS: readonly string[] = Object.freeze(
  [...new Set(LOCK_REGISTRY.map((entry) => entry.logicalName.split(":")[0]!))].sort(),
);

test("every declared logical lock name is unique, and duplicates name both entries", () => {
  const seen = new Map<string, string>();
  for (const entry of LOCK_REGISTRY) {
    const existing = seen.get(entry.logicalName);
    assert.equal(
      existing,
      undefined,
      `Duplicate logical lock name: "${entry.logicalName}" declared by "${entry.description}" and "${existing}"`,
    );
    seen.set(entry.logicalName, entry.description);
  }
  assert.equal(seen.size, LOCK_REGISTRY.length);
});

test("derived keys collide nowhere across declared lock domains, and collisions name both names", () => {
  const seen = new Map<bigint, string>();
  for (const entry of LOCK_REGISTRY) {
    const conflicting = seen.get(entry.derivedKey);
    assert.equal(
      conflicting,
      undefined,
      `Advisory-lock key collision: "${entry.logicalName}" and "${conflicting}" both derive ${entry.derivedKey}`,
    );
    seen.set(entry.derivedKey, entry.logicalName);
  }
  assert.equal(seen.size, LOCK_REGISTRY.length);
});

test("identical workflow names in different domains derive different keys", () => {
  for (const left of DOMAINS) {
    for (const right of DOMAINS) {
      if (left === right) continue;
      const leftKey = deriveLockKey(lockName(left, "shared-workflow", "v1", "global"));
      const rightKey = deriveLockKey(lockName(right, "shared-workflow", "v1", "global"));
      assert.notEqual(
        leftKey,
        rightKey,
        `Domain "${left}" and "${right}" collide for shared-workflow (${leftKey})`,
      );
    }
  }
});

test("declared domain ids are unique documentation anchors", () => {
  const ids = Object.values(LOCK_DOMAIN);
  assert.equal(new Set(ids).size, ids.length);
});

test("every registry entry parses into four segments and resolves back to itself", () => {
  for (const entry of LOCK_REGISTRY) {
    const segments = entry.logicalName.split(":");
    assert.equal(segments.length, 4, `Malformed lock name: ${entry.logicalName}`);
    for (const segment of segments) {
      assert.notEqual(segment, "", `Empty segment in lock name: ${entry.logicalName}`);
    }
    assert.equal(entry.derivedKey, deriveLockKey(entry.logicalName));
    assert.equal(resolveKey(entry.derivedKey)?.logicalName, entry.logicalName);
  }
});

test("the v1 key fixture matches the declared registry", () => {
  assert.deepEqual(
    LOCK_REGISTRY.map((entry) => ({
      logicalName: entry.logicalName,
      key: entry.derivedKey.toString(),
    })),
    PINNED_KEYS_V1,
  );
});

test("bumping a version segment leaves the declared v1 namespace", () => {
  const declared = new Set(LOCK_REGISTRY.map((entry) => entry.derivedKey.toString()));
  for (const entry of LOCK_REGISTRY) {
    const [domain, workflow, , resource] = entry.logicalName.split(":");
    const bumped = deriveLockKey(lockName(domain!, workflow!, "v2", resource!)).toString();
    assert.equal(
      declared.has(bumped),
      false,
      `v2 key for "${entry.logicalName}" collides with a declared v1 key`,
    );
  }
});

test("keys remain stamped within the PostgreSQL signed int8 range", () => {
  const min = -(2n ** 63n);
  const max = 2n ** 63n - 1n;
  for (const entry of LOCK_REGISTRY) {
    assert.ok(
      entry.derivedKey >= min && entry.derivedKey <= max,
      `Key out of int8 range for ${entry.logicalName}: ${entry.derivedKey}`,
    );
  }
});
