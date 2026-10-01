import { PrismaClientKnownRequestError } from "@/app/generated/prisma/internal/prismaNamespace";

export const RETRYABLE_PRISMA_CODES = Object.freeze(["P2034"] as const);

export type RetryablePrismaCode = (typeof RETRYABLE_PRISMA_CODES)[number];

export function isRetryablePrismaError(error: unknown): error is PrismaClientKnownRequestError {
  if (!(error instanceof PrismaClientKnownRequestError)) {
    return false;
  }
  return RETRYABLE_PRISMA_CODES.includes(error.code as RetryablePrismaCode);
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
  deadlineMs: 5000,
});

export interface RetryContext {
  attempt: number;
  deadline: number;
  policy: RetryPolicy;
}

export function calculateDelay(context: RetryContext, remainingBudgetMs?: number): number {
  const { attempt, policy } = context;
  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = cappedDelay * Math.random();
  let delay = Math.floor(cappedDelay / 2 + jitter);

  if (remainingBudgetMs !== undefined && remainingBudgetMs > 0) {
    delay = Math.min(delay, remainingBudgetMs);
  }

  return delay;
}

export function isDeadlineExceeded(context: RetryContext): boolean {
  return Date.now() >= context.deadline;
}

export function getRemainingBudgetMs(deadline: number): number {
  return deadline - Date.now();
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly deadlineMs: number,
  ) {
    super(`Transaction retry exhausted after ${attempts} attempts within ${deadlineMs}ms`);
    this.name = "RetryExhaustedError";
  }
}

export class NonRetryableError extends Error {
  constructor(
    public readonly originalError: Error,
  ) {
    super("Non-retryable database error");
    this.name = "NonRetryableError";
  }
}

/**
 * Options for transaction retry behavior.
 *
 * IMPORTANT: The callback passed to `withTransactionRetry` MUST be idempotent
 * with respect to the database transaction. The retry helper will re-execute
 * the callback on retryable failures (P2034 serialization/deadlock errors).
 *
 * Callers MUST ensure:
 * - The callback performs ALL database writes within a single Prisma transaction
 *   (via `prisma.$transaction(...)` or `tx` callback). Do not perform writes
 *   outside the transaction.
 * - The callback does NOT contain external side effects (HTTP calls, file writes,
 *   message queue publishes, etc.) — these would execute multiple times on retry.
 * - The callback is deterministic: given the same inputs, it produces the same
 *   database effects.
 *
 * The `idempotencyKey` parameter has been intentionally removed. A real
 * distributed idempotency mechanism (e.g., using database advisory locks or a
 * dedicated idempotency table) is out of scope for this retry helper and should
 * be implemented at the application layer if needed.
 */
export interface TransactionRetryOptions {
  policy?: Partial<RetryPolicy>;
  onRetry?: (error: Error, attempt: number) => void;
  signal?: AbortSignal;
}

export async function withTransactionRetry<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...options.policy,
  };

  const deadline = Date.now() + policy.deadlineMs;
  let attempt = 0;
  let lastError: Error;

  const externalSignal = options.signal;
  const controller = new AbortController();
  const internalSignal = controller.signal;

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, internalSignal])
    : internalSignal;

  while (true) {
    attempt++;
    const context: RetryContext = {
      attempt,
      deadline,
      policy,
    };

    try {
      const result = await callback(signal);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (lastError instanceof DOMException && lastError.name === "AbortError") {
        throw lastError;
      }

      if (!isRetryablePrismaError(error)) {
        throw new NonRetryableError(lastError);
      }

      if (attempt >= policy.maxAttempts || isDeadlineExceeded(context)) {
        throw new RetryExhaustedError(attempt, lastError, policy.deadlineMs);
      }

      options.onRetry?.(lastError, attempt);

      const remainingBudgetMs = getRemainingBudgetMs(deadline);
      if (remainingBudgetMs <= 0) {
        throw new RetryExhaustedError(attempt, lastError, policy.deadlineMs);
      }

      const delay = calculateDelay(context, remainingBudgetMs);
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
  }
}