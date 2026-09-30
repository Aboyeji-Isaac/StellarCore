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

export function calculateDelay(context: RetryContext): number {
  const { attempt, policy } = context;
  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = cappedDelay * Math.random();
  return Math.floor(cappedDelay / 2 + jitter);
}

export function isDeadlineExceeded(context: RetryContext): boolean {
  return Date.now() >= context.deadline;
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly deadlineMs: number,
  ) {
    super(
      `Transaction retry exhausted after ${attempts} attempts within ${deadlineMs}ms: ${lastError.message}`,
    );
    this.name = "RetryExhaustedError";
  }
}

export class NonRetryableError extends Error {
  constructor(
    public readonly originalError: Error,
  ) {
    super(`Non-retryable error: ${originalError.message}`);
    this.name = "NonRetryableError";
  }
}

export interface TransactionRetryOptions {
  policy?: Partial<RetryPolicy>;
  onRetry?: (error: Error, attempt: number) => void;
  idempotencyKey?: string;
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

      const delay = calculateDelay(context);
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

export function createIdempotentTransaction<T>(
  key: string,
  callback: (signal: AbortSignal) => Promise<T>,
  options: TransactionRetryOptions = {},
): () => Promise<T> {
  let executed = false;
  let result: T;
  let error: Error | null = null;

  return async () => {
    if (executed) {
      if (error) throw error;
      return result;
    }

    try {
      result = await withTransactionRetry(callback, {
        ...options,
        idempotencyKey: key,
      });
      executed = true;
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      executed = true;
      throw error;
    }
  };
}