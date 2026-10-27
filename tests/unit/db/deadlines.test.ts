import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseDeadlineExceededError,
  withDatabaseDeadline,
} from "@/lib/db/deadlines";

test("completes successfully when operation finishes within deadline", async () => {
  const result = await withDatabaseDeadline(async () => {
    return "done";
  }, { timeoutMs: 100 });

  assert.equal(result, "done");
});

test("throws DatabaseDeadlineExceededError when operation exceeds timeout", async () => {
  await assert.rejects(
    async () => {
      await withDatabaseDeadline(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "too late";
        },
        { timeoutMs: 20 },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof DatabaseDeadlineExceededError);
      assert.equal(err.code, "DATABASE_DEADLINE_EXCEEDED");
      assert.equal(err.timeoutMs, 20);
      return true;
    },
  );
});

test("aborts operation when parent AbortSignal is aborted", async () => {
  const controller = new AbortController();

  const promise = withDatabaseDeadline(
    async (signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted internally"));
        });
      });
    },
    { signal: controller.signal },
  );

  controller.abort();

  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof DatabaseDeadlineExceededError);
      return true;
    },
  );
});

test("throws immediately if signal is already aborted prior to invocation", async () => {
  const controller = new AbortController();
  controller.abort();

  let called = false;
  await assert.rejects(
    async () => {
      await withDatabaseDeadline(
        async () => {
          called = true;
          return "unreachable";
        },
        { signal: controller.signal },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof DatabaseDeadlineExceededError);
      return true;
    },
  );

  assert.equal(called, false);
});
