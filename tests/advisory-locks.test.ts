import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADVISORY_LOCK_REGISTRY,
  deriveAdvisoryLockKey,
  describeAdvisoryLock,
  verifyAdvisoryLockRegistry,
  type AdvisoryLockDefinition,
} from "../lib/db/advisoryLock";

describe("PostgreSQL Namespaced Advisory Locks (Issue #235)", () => {
  it("verifies zero collisions across all declared locks in registry", () => {
    const verification = verifyAdvisoryLockRegistry(ADVISORY_LOCK_REGISTRY);

    assert.strictEqual(verification.ok, true);
    assert.strictEqual(verification.collisions.length, 0);
    assert.strictEqual(
      verification.totalLocks,
      ADVISORY_LOCK_REGISTRY.length,
      "All registered locks must be verified",
    );
  });

  it("isolates keys by domain even with identical resource names", () => {
    const refreshKey = deriveAdvisoryLockKey("REFRESH", "HEARTBEAT", 1);
    const maintenanceKey = deriveAdvisoryLockKey("MAINTENANCE", "HEARTBEAT", 1);
    const discoveryKey = deriveAdvisoryLockKey("DISCOVERY", "HEARTBEAT", 1);

    assert.notStrictEqual(refreshKey.key64, maintenanceKey.key64);
    assert.notStrictEqual(refreshKey.key64, discoveryKey.key64);
    assert.notStrictEqual(maintenanceKey.key64, discoveryKey.key64);
  });

  it("produces distinct keys when incrementing version for rolling deployment", () => {
    const v1 = deriveAdvisoryLockKey("REFRESH", "DAILY_SCHEDULED_REFRESH", 1);
    const v2 = deriveAdvisoryLockKey("REFRESH", "DAILY_SCHEDULED_REFRESH", 2);

    assert.notStrictEqual(v1.key64, v2.key64);
    assert.notStrictEqual(v1.classId, v2.classId);
    assert.notStrictEqual(v1.canonicalName, v2.canonicalName);
  });

  it("derives deterministic 64-bit BigInt and 32-bit integer pairs", () => {
    const derived1 = deriveAdvisoryLockKey("SNAPSHOT", "RATE_SNAPSHOT_OBSERVATION", 1);
    const derived2 = deriveAdvisoryLockKey("SNAPSHOT", "RATE_SNAPSHOT_OBSERVATION", 1);

    assert.strictEqual(derived1.key64, derived2.key64);
    assert.strictEqual(derived1.classId, derived2.classId);
    assert.strictEqual(derived1.objId, derived2.objId);
    assert.strictEqual(derived1.canonicalName, "stellarcore:v1:SNAPSHOT:RATE_SNAPSHOT_OBSERVATION");
  });

  it("provides operator-readable diagnostics without exposing sensitive data", () => {
    const target = deriveAdvisoryLockKey("MIGRATION", "DATABASE_MIGRATION_DEPLOY", 1);
    const diag = describeAdvisoryLock(target.key64);

    assert.strictEqual(diag.recognized, true);
    assert.strictEqual(diag.logicalName, "DATABASE_MIGRATION_DEPLOY");
    assert.strictEqual(diag.domain, "MIGRATION");
    assert.strictEqual(diag.version, 1);
    assert.strictEqual(diag.key64, target.key64.toString());

    // Unknown lock diagnostics
    const unknownDiag = describeAdvisoryLock(BigInt("9999999999999999"));
    assert.strictEqual(unknownDiag.recognized, false);
    assert.strictEqual(unknownDiag.logicalName, undefined);
  });

  it("detects deliberate simulated collisions in custom registry", () => {
    const badRegistry: AdvisoryLockDefinition[] = [
      { domain: "REFRESH", name: "TASK_A", version: 1, description: "A" },
      { domain: "REFRESH", name: "TASK_A", version: 1, description: "Duplicate of A" },
    ];

    const result = verifyAdvisoryLockRegistry(badRegistry);
    assert.strictEqual(result.ok, false);
    assert.ok(result.collisions.length > 0);
  });

  it("rejects unknown lock domains", () => {
    assert.throws(
      // @ts-expect-error testing invalid domain
      () => deriveAdvisoryLockKey("INVALID_DOMAIN", "TASK"),
      /Invalid advisory lock domain/,
    );
  });
});
