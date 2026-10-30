import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@/app/generated/prisma/client";
import {
  REPUTATION_SNAPSHOT_MAX_ATTEMPTS,
  ReputationSnapshotAbort,
  isReputationSnapshotAbort,
  isTransientSnapshotError,
  readInReputationSnapshot,
  readSnapshotIdentity,
} from "@/lib/reputation/snapshot";

test("isTransientSnapshotError classifies 40001, 40P01, and 55P03 as transient/retryable", () => {
  // 40001: serialization_failure
  assert.equal(isTransientSnapshotError({ code: "40001" }), true);
  // 40P01: deadlock_detected
  assert.equal(isTransientSnapshotError({ code: "40P01" }), true);
  // 55P03: lock_not_available (lock timeout)
  assert.equal(isTransientSnapshotError({ code: "55P03" }), true);
});

test("isTransientSnapshotError classifies other PostgreSQL and generic errors as non-retryable", () => {
  // 23505: unique_violation
  assert.equal(isTransientSnapshotError({ code: "23505" }), false);
  // 42P01: undefined_table
  assert.equal(isTransientSnapshotError({ code: "42P01" }), false);
  // 08006: connection_failure
  assert.equal(isTransientSnapshotError({ code: "08006" }), false);
  // 28P01: invalid_password
  assert.equal(isTransientSnapshotError({ code: "28P01" }), false);
  // Error with non-string code
  assert.equal(isTransientSnapshotError({ code: 40001 }), false);
  // Standard Error instances
  assert.equal(isTransientSnapshotError(new Error("generic error")), false);
  // null / undefined / primitives
  assert.equal(isTransientSnapshotError(null), false);
  assert.equal(isTransientSnapshotError(undefined), false);
  assert.equal(isTransientSnapshotError("40001"), false);
  assert.equal(isTransientSnapshotError({}), false);
});

test("isReputationSnapshotAbort identifies ReputationSnapshotAbort instances", () => {
  assert.equal(isReputationSnapshotAbort(new ReputationSnapshotAbort()), true);
  assert.equal(isReputationSnapshotAbort(new ReputationSnapshotAbort("custom")), true);
  assert.equal(isReputationSnapshotAbort(new Error("custom")), false);
  assert.equal(isReputationSnapshotAbort(null), false);
  assert.equal(isReputationSnapshotAbort({ name: "ReputationSnapshotAbort" }), false);
});

test("readSnapshotIdentity extracts snapshot ID and readAt date", async () => {
  const fakeTx = {
    $queryRaw: async () => [
      { snapshot_id: "123:456:", read_at: new Date("2026-10-19T12:00:00.000Z") },
    ],
  } as unknown as Prisma.TransactionClient;

  const identity = await readSnapshotIdentity(fakeTx);
  assert.equal(identity.snapshotId, "123:456:");
  assert.equal(identity.readAt.toISOString(), "2026-10-19T12:00:00.000Z");
});

test("readSnapshotIdentity throws when row or fields are invalid", async () => {
  const emptyTx = {
    $queryRaw: async () => [],
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(
    () => readSnapshotIdentity(emptyTx),
    /REPUTATION_SNAPSHOT_IDENTITY_UNAVAILABLE/,
  );

  const invalidDateTx = {
    $queryRaw: async () => [{ snapshot_id: "123", read_at: "invalid-date" }],
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(
    () => readSnapshotIdentity(invalidDateTx),
    /REPUTATION_SNAPSHOT_IDENTITY_UNAVAILABLE/,
  );
});

test("readInReputationSnapshot succeeds on first attempt without retrying", async () => {
  let transactionCalls = 0;
  let readCalls = 0;

  const mockDb = {
    $transaction: async <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
      _options: unknown,
    ): Promise<R> => {
      transactionCalls += 1;
      const fakeTx = {
        $executeRaw: async (query: TemplateStringsArray) => {
          assert.equal(query.join(""), "SET TRANSACTION READ ONLY");
          return 1;
        },
        $queryRaw: async () => [
          { snapshot_id: "snapshot-1", read_at: new Date("2026-10-19T12:00:00.000Z") },
        ],
      } as unknown as Prisma.TransactionClient;

      return fn(fakeTx);
    },
  };

  const result = await readInReputationSnapshot(mockDb, async (_tx, identity) => {
    readCalls += 1;
    return `evidence-for-${identity.snapshotId}`;
  });

  assert.equal(transactionCalls, 1);
  assert.equal(readCalls, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "evidence-for-snapshot-1");
    assert.equal(result.snapshot.snapshotId, "snapshot-1");
    assert.equal(result.snapshot.isolationLevel, "REPEATABLE READ");
  }
});

test("readInReputationSnapshot retries on 40001 (serialization failure) and succeeds on subsequent attempt", async () => {
  let transactionCalls = 0;
  let readCalls = 0;

  const mockDb = {
    $transaction: async <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
    ): Promise<R> => {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        const err = new Error("could not serialize access due to concurrent update");
        (err as unknown as { code: string }).code = "40001";
        throw err;
      }

      const fakeTx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [
          { snapshot_id: "snapshot-attempt-2", read_at: new Date("2026-10-19T12:00:01.000Z") },
        ],
      } as unknown as Prisma.TransactionClient;

      return fn(fakeTx);
    },
  };

  const result = await readInReputationSnapshot(mockDb, async (_tx, identity) => {
    readCalls += 1;
    return `result-${identity.snapshotId}`;
  });

  assert.equal(transactionCalls, 2);
  assert.equal(readCalls, 1); // read was only reached on attempt 2
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "result-snapshot-attempt-2");
    assert.equal(result.snapshot.snapshotId, "snapshot-attempt-2");
  }
});

test("readInReputationSnapshot retries on 40P01 (deadlock detected) and 55P03 (lock timeout)", async () => {
  let transactionCalls = 0;

  const mockDb = {
    $transaction: async <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
    ): Promise<R> => {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        const err = new Error("deadlock detected");
        (err as unknown as { code: string }).code = "40P01";
        throw err;
      }
      if (transactionCalls === 2) {
        const err = new Error("canceling statement due to lock timeout");
        (err as unknown as { code: string }).code = "55P03";
        throw err;
      }

      const fakeTx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [
          { snapshot_id: "snapshot-attempt-3", read_at: new Date("2026-10-19T12:00:02.000Z") },
        ],
      } as unknown as Prisma.TransactionClient;

      return fn(fakeTx);
    },
  };

  const result = await readInReputationSnapshot(mockDb, async () => "ok");

  assert.equal(transactionCalls, 3);
  assert.equal(result.ok, true);
});

test("readInReputationSnapshot stops retrying after REPUTATION_SNAPSHOT_MAX_ATTEMPTS and returns deterministic failure", async () => {
  let transactionCalls = 0;

  const mockDb = {
    $transaction: async <R>(): Promise<R> => {
      transactionCalls += 1;
      const err = new Error("could not serialize access");
      (err as unknown as { code: string }).code = "40001";
      throw err;
    },
  };

  const result = await readInReputationSnapshot(mockDb, async () => "never-reached");

  assert.equal(transactionCalls, REPUTATION_SNAPSHOT_MAX_ATTEMPTS);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "EVIDENCE_READ_SERIALIZATION_FAILURE");
    assert.equal(result.failure.retryable, true);
    assert.equal(result.failure.attempts, 3);
  }
});

test("readInReputationSnapshot exits immediately without retrying on non-retryable database error", async () => {
  let transactionCalls = 0;

  const mockDb = {
    $transaction: async <R>(): Promise<R> => {
      transactionCalls += 1;
      const err = new Error("relation does not exist");
      (err as unknown as { code: string }).code = "42P01";
      throw err;
    },
  };

  const result = await readInReputationSnapshot(mockDb, async () => "never-reached");

  assert.equal(transactionCalls, 1); // No retry
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "EVIDENCE_READ_FAILURE");
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.attempts, 1);
  }
});

test("readInReputationSnapshot exits immediately without retrying on ReputationSnapshotAbort", async () => {
  let transactionCalls = 0;
  let readCalls = 0;

  const mockDb = {
    $transaction: async <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
    ): Promise<R> => {
      transactionCalls += 1;
      const fakeTx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [
          { snapshot_id: "snapshot-abort", read_at: new Date() },
        ],
      } as unknown as Prisma.TransactionClient;

      return fn(fakeTx);
    },
  };

  const result = await readInReputationSnapshot(mockDb, async () => {
    readCalls += 1;
    throw new ReputationSnapshotAbort("Anchor disappeared mid-evaluation");
  });

  assert.equal(transactionCalls, 1); // No retry
  assert.equal(readCalls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "EVIDENCE_READ_FAILURE");
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.attempts, 1);
  }
});

test("readInReputationSnapshot passes correct transaction options to $transaction", async () => {
  let passedOptions: unknown = null;

  const mockDb = {
    $transaction: async <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
      options: unknown,
    ): Promise<R> => {
      passedOptions = options;
      const fakeTx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ snapshot_id: "snap", read_at: new Date() }],
      } as unknown as Prisma.TransactionClient;
      return fn(fakeTx);
    },
  };

  await readInReputationSnapshot(mockDb, async () => 42);

  assert.deepEqual(passedOptions, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000,
    timeout: 10_000,
  });
});
