import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClientKnownRequestError } from "@/app/generated/prisma/internal/prismaNamespace";

import {
  isRetryablePrismaError,
  RETRYABLE_PRISMA_CODES,
  calculateDelay,
  isDeadlineExceeded,
  withTransactionRetry,
  RetryExhaustedError,
  NonRetryableError,
  createIdempotentTransaction,
  DEFAULT_RETRY_POLICY,
} from "@/lib/db/retry";

test("RETRYABLE_PRISMA_CODES contains expected codes", () => {
  assert.deepEqual(RETRYABLE_PRISMA_CODES, ["P2034"]);
});

test("isRetryablePrismaError identifies P2034 as retryable", () => {
  const error = new PrismaClientKnownRequestError("deadlock", {
    code: "P2034",
    clientVersion: "7.9.1",
  });
  assert.equal(isRetryablePrismaError(error), true);
});

test("isRetryablePrismaError rejects P2003 foreign key violation", () => {
  const error = new PrismaClientKnownRequestError("FK violation", {
    code: "P2003",
    clientVersion: "7.9.1",
  });
  assert.equal(isRetryablePrismaError(error), false);
});

test("isRetryablePrismaError rejects P2002 unique constraint violation", () => {
  const error = new PrismaClientKnownRequestError("Unique violation", {
    code: "P2002",
    clientVersion: "7.9.1",
  });
  assert.equal(isRetryablePrismaError(error), false);
});

test("isRetryablePrismaError rejects unknown error codes", () => {
  const error = new PrismaClientKnownRequestError("Unknown", {
    code: "P9999",
    clientVersion: "7.9.1",
  });
  assert.equal(isRetryablePrismaError(error), false);
});

test("isRetryablePrismaError rejects non-Prisma errors", () => {
  assert.equal(isRetryablePrismaError(new Error("plain error")), false);
  assert.equal(isRetryablePrismaError("string error"), false);
  assert.equal(isRetryablePrismaError(null), false);
  assert.equal(isRetryablePrismaError(undefined), false);
});

test("calculateDelay applies exponential backoff with jitter", () => {
  const context = {
    attempt: 1,
    deadline: Date.now() + 10000,
    policy: DEFAULT_RETRY_POLICY,
  };

  const delays = new Set<number>();
  for (let i = 0; i < 100; i++) {
    delays.add(calculateDelay(context));
  }

  assert.ok(delays.size > 1, "jitter should produce variation");
  for (const delay of delays) {
    assert.ok(delay >= 0);
    assert.ok(delay <= DEFAULT_RETRY_POLICY.maxDelayMs);
  }
});

test("calculateDelay increases with attempt number", () => {
  const baseContext = {
    deadline: Date.now() + 10000,
    policy: DEFAULT_RETRY_POLICY,
  };

  const attempt1Delays: number[] = [];
  const attempt2Delays: number[] = [];

  for (let i = 0; i < 50; i++) {
    attempt1Delays.push(calculateDelay({ ...baseContext, attempt: 1 }));
    attempt2Delays.push(calculateDelay({ ...baseContext, attempt: 2 }));
  }

  const avg1 = attempt1Delays.reduce((a, b) => a + b, 0) / attempt1Delays.length;
  const avg2 = attempt2Delays.reduce((a, b) => a + b, 0) / attempt2Delays.length;

  assert.ok(avg2 > avg1, "delay should increase with attempt");
});

test("isDeadlineExceeded returns false before deadline", () => {
  const context = {
    attempt: 1,
    deadline: Date.now() + 1000,
    policy: DEFAULT_RETRY_POLICY,
  };
  assert.equal(isDeadlineExceeded(context), false);
});

test("isDeadlineExceeded returns true after deadline", () => {
  const context = {
    attempt: 1,
    deadline: Date.now() - 1000,
    policy: DEFAULT_RETRY_POLICY,
  };
  assert.equal(isDeadlineExceeded(context), true);
});

test("withTransactionRetry succeeds on first attempt", async () => {
  let callCount = 0;
  const result = await withTransactionRetry(async () => {
    callCount++;
    return "success";
  });

  assert.equal(result, "success");
  assert.equal(callCount, 1);
});

test("withTransactionRetry retries on P2034 and succeeds", async () => {
  let callCount = 0;
  const result = await withTransactionRetry(async () => {
    callCount++;
    if (callCount < 3) {
      throw new PrismaClientKnownRequestError("deadlock", {
        code: "P2034",
        clientVersion: "7.9.1",
      });
    }
    return "success";
  }, { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, deadlineMs: 1000 } });

  assert.equal(result, "success");
  assert.equal(callCount, 3);
});

test("withTransactionRetry throws RetryExhaustedError after max attempts", async () => {
  let callCount = 0;
  let lastError: Error | null = null;

  try {
    await withTransactionRetry(async () => {
      callCount++;
      throw new PrismaClientKnownRequestError("deadlock", {
        code: "P2034",
        clientVersion: "7.9.1",
      });
    }, { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, deadlineMs: 1000 } });
  } catch (error) {
    lastError = error as Error;
  }

  assert.ok(lastError instanceof RetryExhaustedError);
  assert.equal(callCount, 3);
  assert.ok(lastError!.message.includes("3 attempts"));
});

test("withTransactionRetry throws NonRetryableError for non-retryable errors", async () => {
  let lastError: Error | null = null;

  try {
    await withTransactionRetry(async () => {
      throw new PrismaClientKnownRequestError("FK violation", {
        code: "P2003",
        clientVersion: "7.9.1",
      });
    });
  } catch (error) {
    lastError = error as Error;
  }

  assert.ok(lastError instanceof NonRetryableError);
  assert.ok(lastError!.message.includes("Non-retryable"));
});

test("withTransactionRetry respects deadline", async () => {
  let callCount = 0;
  let lastError: Error | null = null;

  try {
    await withTransactionRetry(async () => {
      callCount++;
      throw new PrismaClientKnownRequestError("deadlock", {
        code: "P2034",
        clientVersion: "7.9.1",
      });
    }, { policy: { maxAttempts: 100, baseDelayMs: 10, maxDelayMs: 50, deadlineMs: 50 } });
  } catch (error) {
    lastError = error as Error;
  }

  assert.ok(lastError instanceof RetryExhaustedError);
  assert.ok(callCount >= 1);
});

test("withTransactionRetry preserves AbortSignal", async () => {
  let lastError: Error | null = null;
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 10);

  try {
    await withTransactionRetry(
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
          setTimeout(resolve, 1000);
        });
      },
      { signal: controller.signal },
    );
  } catch (error) {
    lastError = error as Error;
  }

  assert.ok(lastError instanceof DOMException);
  assert.equal(lastError!.name, "AbortError");
});

test("withTransactionRetry calls onRetry callback", async () => {
  const retries: number[] = [];
  let callCount = 0;

  await withTransactionRetry(
    async () => {
      callCount++;
      if (callCount < 3) {
        throw new PrismaClientKnownRequestError("deadlock", {
          code: "P2034",
          clientVersion: "7.9.1",
        });
      }
      return "success";
    },
    {
      policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5, deadlineMs: 1000 },
      onRetry: (error, attempt) => {
        retries.push(attempt);
        assert.ok(error instanceof PrismaClientKnownRequestError);
      },
    },
  );

  assert.deepEqual(retries, [1, 2]);
});

test("createIdempotentTransaction executes once and caches result", async () => {
  let callCount = 0;
  const idempotentFn = createIdempotentTransaction("test-key", async () => {
    callCount++;
    return "result";
  });

  const result1 = await idempotentFn();
  const result2 = await idempotentFn();
  const result3 = await idempotentFn();

  assert.equal(result1, "result");
  assert.equal(result2, "result");
  assert.equal(result3, "result");
  assert.equal(callCount, 1);
});

test("createIdempotentTransaction caches error", async () => {
  let callCount = 0;
  const idempotentFn = createIdempotentTransaction("test-key-error", async () => {
    callCount++;
    throw new Error("fail");
  });

  let error1: Error | null = null;
  let error2: Error | null = null;

  try {
    await idempotentFn();
  } catch (e) {
    error1 = e as Error;
  }

  try {
    await idempotentFn();
  } catch (e) {
    error2 = e as Error;
  }

  assert.ok(error1 instanceof NonRetryableError);
  assert.ok(error1!.message.includes("fail"));
  assert.strictEqual(error1, error2);
  assert.equal(callCount, 1);
});

test("withTransactionRetry does not retry on deadline exceeded", async () => {
  let callCount = 0;
  let lastError: Error | null = null;

  try {
    await withTransactionRetry(
      async () => {
        callCount++;
        throw new PrismaClientKnownRequestError("deadlock", {
          code: "P2034",
          clientVersion: "7.9.1",
        });
      },
      { policy: { maxAttempts: 10, baseDelayMs: 50, maxDelayMs: 100, deadlineMs: 100 } },
    );
  } catch (error) {
    lastError = error as Error;
  }

  assert.ok(lastError instanceof RetryExhaustedError);
  assert.ok(callCount <= 3);
});

test("RetryExhaustedError includes attempt count and deadline", async () => {
  let lastError: RetryExhaustedError | null = null;

  try {
    await withTransactionRetry(
      async () => {
        throw new PrismaClientKnownRequestError("deadlock", {
          code: "P2034",
          clientVersion: "7.9.1",
        });
      },
      { policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, deadlineMs: 1000 } },
    );
  } catch (error) {
    lastError = error as RetryExhaustedError;
  }

  assert.ok(lastError instanceof RetryExhaustedError);
  assert.equal(lastError!.attempts, 2);
  assert.equal(lastError!.deadlineMs, 1000);
  assert.ok(lastError!.lastError instanceof PrismaClientKnownRequestError);
});