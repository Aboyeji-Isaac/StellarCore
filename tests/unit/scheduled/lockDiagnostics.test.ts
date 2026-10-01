import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseLockKey, listRegisteredLocks } from "@/lib/scheduled/lockDiagnostics";
import { LOCK_REGISTRY } from "@/lib/scheduled/advisoryLockKey";

// ---------------------------------------------------------------------------
// diagnoseLockKey — registered keys
// ---------------------------------------------------------------------------

test("diagnoseLockKey resolves every registry key to its logical name and domainId", () => {
  for (const entry of LOCK_REGISTRY) {
    const result = diagnoseLockKey(entry.derivedKey);
    assert.equal(result.key, entry.derivedKey.toString());
    assert.equal(result.logicalName, entry.logicalName);
    assert.equal(result.domainId, entry.domainId);
    assert.ok(result.description != null && result.description.length > 0);
  }
});

test("diagnoseLockKey accepts string and number inputs as well as bigint", () => {
  const entry = LOCK_REGISTRY[0]!;
  const fromBigInt = diagnoseLockKey(entry.derivedKey);
  const fromString = diagnoseLockKey(entry.derivedKey.toString());

  assert.equal(fromBigInt.logicalName, entry.logicalName);
  assert.equal(fromString.logicalName, entry.logicalName);
});

// ---------------------------------------------------------------------------
// diagnoseLockKey — unknown keys
// ---------------------------------------------------------------------------

test("diagnoseLockKey returns null fields for an unregistered key", () => {
  const result = diagnoseLockKey(0n);
  assert.equal(result.logicalName, null);
  assert.equal(result.domainId, null);
  assert.equal(result.description, null);
  assert.equal(result.key, "0");
});

test("diagnoseLockKey output never contains DATABASE_URL or connection strings", () => {
  const outputs = [
    diagnoseLockKey(0n),
    ...LOCK_REGISTRY.map((e) => diagnoseLockKey(e.derivedKey)),
  ];
  for (const o of outputs) {
    const serialized = JSON.stringify(o);
    assert.equal(serialized.includes("DATABASE_URL"), false);
    assert.equal(serialized.includes("postgresql://"), false);
    assert.equal(serialized.includes("password"), false);
  }
});

// ---------------------------------------------------------------------------
// listRegisteredLocks
// ---------------------------------------------------------------------------

test("listRegisteredLocks returns one entry per LOCK_REGISTRY descriptor", () => {
  const list = listRegisteredLocks();
  assert.equal(list.length, LOCK_REGISTRY.length);
});

test("listRegisteredLocks entries match registry key strings and logical names", () => {
  const list = listRegisteredLocks();
  for (let i = 0; i < LOCK_REGISTRY.length; i++) {
    const entry = LOCK_REGISTRY[i]!;
    const diag = list[i]!;
    assert.equal(diag.key, entry.derivedKey.toString());
    assert.equal(diag.logicalName, entry.logicalName);
    assert.equal(diag.domainId, entry.domainId);
    assert.equal(diag.description, entry.description);
  }
});

test("listRegisteredLocks is frozen and does not leak internal references", () => {
  const list = listRegisteredLocks();
  assert.ok(Object.isFrozen(list));
  for (const entry of list) {
    assert.ok(Object.isFrozen(entry));
  }
});

test("listRegisteredLocks output is safely JSON-serializable", () => {
  assert.doesNotThrow(() => JSON.stringify(listRegisteredLocks()));
});
