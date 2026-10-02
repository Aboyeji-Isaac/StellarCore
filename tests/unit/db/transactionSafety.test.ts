import assert from "node:assert/strict";
import test from "node:test";

import {
  executeSafeTransaction,
  TransactionCommitUnconfirmedError,
  TransactionInterruptedError,
} from "@/lib/db/transactionSafety";

test("executeSafeTransaction returns result upon successful commit", async () => {
  const runner = async (fn: (tx: { dummy: boolean }) => Promise<string>) => {
    return fn({ dummy: true });
  };

  const result = await executeSafeTransaction(runner, async (tx) => {
    assert.equal(tx.dummy, true);
    return "success";
  });

  assert.equal(result, "success");
});

test("throws TransactionInterruptedError when failover occurs during query execution in transaction", async () => {
  const runner = async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({});
  };

  await assert.rejects(
    async () => {
      await executeSafeTransaction(runner, async () => {
        const error = Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
        throw error;
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof TransactionInterruptedError);
      assert.equal(err.code, "TRANSACTION_INTERRUPTED");
      assert.equal(err.phase, "IN_FLIGHT");
      return true;
    },
  );
});

test("throws TransactionCommitUnconfirmedError when connection fails during commit phase", async () => {
  const runner = async (fn: (tx: unknown) => Promise<unknown>) => {
    await fn({});
    // Simulate connection failure during COMMIT step executed by transaction runner
    const commitErr = Object.assign(new Error("Connection terminated during COMMIT"), {
      code: "08006",
    });
    throw commitErr;
  };

  await assert.rejects(
    async () => {
      await executeSafeTransaction(runner, async () => {
        return { modified: true };
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof TransactionCommitUnconfirmedError);
      assert.equal(err.code, "TRANSACTION_INTERRUPTED");
      assert.equal(err.phase, "COMMITTING");
      return true;
    },
  );
});

test("throws TransactionCommitUnconfirmedError on SQLState 08007 transaction resolution unknown", async () => {
  const runner = async (fn: (tx: unknown) => Promise<unknown>) => {
    await fn({});
    const error = Object.assign(new Error("Resolution unknown"), { code: "08007" });
    throw error;
  };

  await assert.rejects(
    async () => {
      await executeSafeTransaction(runner, async () => {
        return "data";
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof TransactionCommitUnconfirmedError);
      assert.equal(err.phase, "COMMITTING");
      return true;
    },
  );
});

test("re-throws standard query errors without classifying as transaction interrupted", async () => {
  const runner = async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({});
  };

  await assert.rejects(
    async () => {
      await executeSafeTransaction(runner, async () => {
        const uniqueErr = Object.assign(new Error("Duplicate key"), { code: "23505" });
        throw uniqueErr;
      });
    },
    (err: unknown) => {
      assert.ok(!(err instanceof TransactionInterruptedError));
      assert.equal((err as { code: string }).code, "23505");
      return true;
    },
  );
});
