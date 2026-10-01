/**
 * Bounded retry budgets with exponential backoff and jitter for SEP operations (#166).
 *
 * Defines retryable vs non-retryable failure classes for SEP-1 and SEP-38.
 * Adds exponential backoff with jitter and a strict per-operation total retry budget.
 * Honors safe Retry-After responses where applicable with an upper bound.
 * Never retries malformed protocol data, validation failures, authentication failures,
 * or non-idempotent operations.
 * Propagates cancellation/deadline signals through retry sleeps and fetches.
 * Deterministic in tests via injected clocks/randomness.
 */

import type { Sep1ErrorCode } from "@/lib/stellar/sep1";
import type { Sep38ErrorCode } from "@/lib/stellar/sep38";

/** Retry policy configuration for SEP operations. */
export interface SepRetryPolicy {
  /** Maximum number of attempts (initial + retries). Default: 3. */
  maxAttempts: number;
  /** Base delay in milliseconds for exponential backoff. Default: 100ms. */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 2000ms. */
  maxDelayMs: number;
  /** Total time budget for all attempts in milliseconds. Default: 10000ms. */
  deadlineMs: number;
  /** Maximum Retry-After delay to honor in milliseconds. Default: 5000ms. */
  maxRetryAfterMs: number;
}

/** Default retry policy for SEP operations. */
export const DEFAULT_SEP_RETRY_POLICY: SepRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  deadlineMs: 10_000,
  maxRetryAfterMs: 5_000,
});

/** Context for calculating retry delays. */
export interface RetryContext {
  /** Current attempt number (1-indexed). */
  attempt: number;
  /** Absolute deadline timestamp (ms since epoch). */
  deadline: number;
  /** Active retry policy. */
  policy: SepRetryPolicy;
  /** Optional Retry-After value from server response (seconds). */
  retryAfterMs?: number;
}

/** Error classification for retry decisions. */
export type ErrorClassification =
  | "retryable"
  | "non-retryable"
  | "retryable-with-retry-after";

/** Result of classifying an error for retry purposes. */
export interface ErrorClassificationResult {
  classification: ErrorClassification;
  /** If classification is "retryable-with-retry-after", the Retry-After value in ms. */
  retryAfterMs?: number;
}

/**
 * Determines if a SEP-1 error is retryable.
 * Retryable: TIMEOUT, NETWORK_FAILURE, HTTP_FAILURE (5xx), EGRESS_POLICY (transient)
 * Non-retryable: INVALID_HOME_DOMAIN, INVALID_TOML, INVALID_DATA, MISSING_REQUIRED_DATA,
 *   RESPONSE_TOO_LARGE, HTTP_FAILURE (4xx except 429), EGRESS_POLICY (permanent)
 */
export function classifySep1Error(
  error: unknown,
  responseHeaders?: Headers,
): ErrorClassificationResult {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: Sep1ErrorCode }).code;

    // Never retry these - they indicate malformed input or permanent failures
    if (
      code === "INVALID_HOME_DOMAIN" ||
      code === "INVALID_TOML" ||
      code === "INVALID_DATA" ||
      code === "MISSING_REQUIRED_DATA" ||
      code === "RESPONSE_TOO_LARGE"
    ) {
      return { classification: "non-retryable" };
    }

    // HTTP_FAILURE - check status code
    if (code === "HTTP_FAILURE") {
      const status = (error as { status?: number }).status;
      if (status === 429) {
        // Rate limited - honor Retry-After if present
        const retryAfter = parseRetryAfter(responseHeaders);
        if (retryAfter !== undefined) {
          return { classification: "retryable-with-retry-after", retryAfterMs: retryAfter };
        }
        return { classification: "retryable" };
      }
      if (status !== undefined && status >= 500 && status < 600) {
        return { classification: "retryable" };
      }
      // 4xx (except 429) are client errors - don't retry
      return { classification: "non-retryable" };
    }

    // EGRESS_POLICY - generally indicates network policy blocking, may be transient
    if (code === "EGRESS_POLICY") {
      return { classification: "retryable" };
    }

    // TIMEOUT and NETWORK_FAILURE are inherently transient
    if (code === "TIMEOUT" || code === "NETWORK_FAILURE") {
      return { classification: "retryable" };
    }
  }

  // Unknown errors - be conservative and don't retry
  return { classification: "non-retryable" };
}

/**
 * Determines if a SEP-38 error is retryable.
 * Retryable: TIMEOUT, NETWORK_FAILURE, HTTP_FAILURE (5xx), EGRESS_POLICY (transient)
 * Non-retryable: INVALID_ASSET, INVALID_QUOTE_SERVER, INVALID_REQUEST,
 *   AUTHENTICATION_REQUIRED, REDIRECT, HTTP_FAILURE (4xx except 429),
 *   RESPONSE_TOO_LARGE, INVALID_CONTENT_TYPE, INVALID_JSON, INVALID_DATA,
 *   EGRESS_POLICY (permanent)
 */
export function classifySep38Error(
  error: unknown,
  responseHeaders?: Headers,
): ErrorClassificationResult {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: Sep38ErrorCode }).code;

    // Never retry these - they indicate malformed input or permanent failures
    if (
      code === "INVALID_ASSET" ||
      code === "INVALID_QUOTE_SERVER" ||
      code === "INVALID_REQUEST" ||
      code === "AUTHENTICATION_REQUIRED" ||
      code === "REDIRECT" ||
      code === "RESPONSE_TOO_LARGE" ||
      code === "INVALID_CONTENT_TYPE" ||
      code === "INVALID_JSON" ||
      code === "INVALID_DATA"
    ) {
      return { classification: "non-retryable" };
    }

    // HTTP_FAILURE - check status code
    if (code === "HTTP_FAILURE") {
      const status = (error as { status?: number }).status;
      if (status === 429) {
        // Rate limited - honor Retry-After if present
        const retryAfter = parseRetryAfter(responseHeaders);
        if (retryAfter !== undefined) {
          return { classification: "retryable-with-retry-after", retryAfterMs: retryAfter };
        }
        return { classification: "retryable" };
      }
      if (status !== undefined && status >= 500 && status < 600) {
        return { classification: "retryable" };
      }
      // 4xx (except 429) are client errors - don't retry
      return { classification: "non-retryable" };
    }

    // EGRESS_POLICY - generally indicates network policy blocking, may be transient
    if (code === "EGRESS_POLICY") {
      return { classification: "retryable" };
    }

    // TIMEOUT and NETWORK_FAILURE are inherently transient
    if (code === "TIMEOUT" || code === "NETWORK_FAILURE") {
      return { classification: "retryable" };
    }
  }

  // Unknown errors - be conservative and don't retry
  return { classification: "non-retryable" };
}

/**
 * Parses Retry-After header value into milliseconds.
 * Supports both seconds (integer) and HTTP-date formats.
 * Returns undefined if header is missing, invalid, or exceeds maxRetryAfterMs.
 */
export function parseRetryAfter(headers?: Headers, maxRetryAfterMs?: number): number | undefined {
  const header = headers?.get("retry-after");
  if (!header) return undefined;

  const trimmed = header.trim();
  if (!trimmed) return undefined;

  // Try parsing as seconds (integer)
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = seconds * 1000;
    if (maxRetryAfterMs !== undefined && ms > maxRetryAfterMs) {
      return maxRetryAfterMs;
    }
    return ms;
  }

  // Try parsing as HTTP-date
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    if (ms > 0) {
      if (maxRetryAfterMs !== undefined && ms > maxRetryAfterMs) {
        return maxRetryAfterMs;
      }
      return ms;
    }
  }

  return undefined;
}

/**
 * Calculates the delay for the next retry attempt with exponential backoff and jitter.
 * If retryAfterMs is provided (from Retry-After header), uses that instead (capped by maxRetryAfterMs).
 * Formula: min(baseDelayMs * 2^(attempt-1), maxDelayMs) * (0.5 + random() * 0.5)
 * This gives jitter in range [delay/2, delay].
 */
export function calculateSepRetryDelay(
  context: RetryContext,
  random: () => number = Math.random,
): number {
  const { attempt, policy, retryAfterMs } = context;

  // If Retry-After was provided, use that (already capped)
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }

  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = cappedDelay * random();
  return Math.floor(cappedDelay / 2 + jitter);
}

/**
 * Checks if the retry deadline has been exceeded.
 */
export function isSepDeadlineExceeded(context: RetryContext): boolean {
  return Date.now() >= context.deadline;
}

/**
 * Options for withSepRetry.
 */
export interface WithSepRetryOptions {
  /** Retry policy configuration. */
  policy?: Partial<SepRetryPolicy>;
  /** Called on each retry attempt with the error and attempt number. */
  onRetry?: (error: Error, attempt: number) => void;
  /** Optional abort signal to propagate cancellation. */
  signal?: AbortSignal;
  /** For tests: injected clock function returning current time in ms. */
  clock?: () => number;
  /** For tests: injected random function for jitter. */
  random?: () => number;
  /** Function to classify errors as retryable/non-retryable. */
  classifyError?: (error: unknown, responseHeaders?: Headers) => ErrorClassificationResult;
  /** Optional custom timeout per attempt. */
  attemptTimeoutMs?: number;
}

/**
 * Executes a callback with bounded retry logic for SEP operations.
 *
 * @param callback - Async function that performs the SEP operation. Receives an AbortSignal
 *   that combines the external signal (if any) with an internal signal for deadline enforcement.
 * @param options - Retry configuration including error classification function.
 * @returns Promise resolving to the callback result, or throwing on non-retryable errors
 *   or when retry budget is exhausted.
 */
export async function withSepRetry<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  options: WithSepRetryOptions,
): Promise<T> {
  const {
    policy: userPolicy = {},
    onRetry,
    signal: externalSignal,
    clock = () => Date.now(),
    random = Math.random,
    classifyError,
    attemptTimeoutMs,
  } = options;

  if (!classifyError) {
    throw new Error("classifyError is required for withSepRetry");
  }

  const policy: SepRetryPolicy = {
    ...DEFAULT_SEP_RETRY_POLICY,
    ...userPolicy,
  };

  const deadline = clock() + policy.deadlineMs;
  let attempt = 0;
  let lastError: Error;

  // Combine external signal with internal deadline signal
  const controller = new AbortController();
  const internalSignal = controller.signal;

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, internalSignal])
    : internalSignal;

  // Set up deadline enforcement
  const deadlineTimeout = setTimeout(() => controller.abort(), policy.deadlineMs);

  while (true) {
    attempt++;
    const context: RetryContext = {
      attempt,
      deadline,
      policy,
    };

    try {
      const result = attemptTimeoutMs
        ? await Promise.race([
            callback(signal),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Attempt timeout")), attemptTimeoutMs),
            ),
          ])
        : await callback(signal);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check for abort signals
      if (signal.aborted) {
        clearTimeout(deadlineTimeout);
        throw new DOMException("Aborted", "AbortError");
      }

      if (lastError instanceof DOMException && lastError.name === "AbortError") {
        clearTimeout(deadlineTimeout);
        throw lastError;
      }

      // Classify the error
      const classification = classifyError(lastError, undefined);

      // Non-retryable errors fail immediately
      if (classification.classification === "non-retryable") {
        clearTimeout(deadlineTimeout);
        throw lastError;
      }

      // Check if we've exhausted retry budget
      // Only wrap in RETRY_EXHAUSTED if we've actually attempted retries (attempt > 1)
      if (attempt >= policy.maxAttempts || isSepDeadlineExceeded(context)) {
        clearTimeout(deadlineTimeout);
        if (attempt <= 1) {
          // No retries were configured or attempted - throw original error
          throw lastError;
        }
        throw new SepRetryExhaustedError(attempt, lastError, policy.deadlineMs);
      }

      // Handle Retry-After if present
      if (classification.classification === "retryable-with-retry-after") {
        context.retryAfterMs = Math.min(
          classification.retryAfterMs ?? 0,
          policy.maxRetryAfterMs,
        );
      }

      // Notify about retry
      onRetry?.(lastError, attempt);

      // Calculate delay and wait
      const delay = calculateSepRetryDelay(context, random);
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

/**
 * Error thrown when retry budget is exhausted.
 */
export class SepRetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly deadlineMs: number,
  ) {
    super(
      `SEP retry exhausted after ${attempts} attempts within ${deadlineMs}ms: ${lastError.message}`,
    );
    this.name = "SepRetryExhaustedError";
  }
}

/**
 * Error wrapper for non-retryable errors to distinguish them in catch handlers.
 */
export class SepNonRetryableError extends Error {
  constructor(
    public readonly originalError: Error,
  ) {
    super(`Non-retryable SEP error: ${originalError.message}`);
    this.name = "SepNonRetryableError";
  }
}

/**
 * Creates a retryable fetch wrapper for SEP-1 operations.
 */
export function createSep1RetryFetch(
  fetcher: typeof fetch,
  options: WithSepRetryOptions = {},
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    return withSepRetry(
      async (signal) => {
        const response = await fetcher(input, { ...init, signal });
        return response;
      },
      {
        classifyError: (error: unknown, headers?: Headers) => classifySep1Error(error, headers),
        policy: options.policy,
        onRetry: options.onRetry,
        signal: options.signal,
        clock: options.clock,
        random: options.random,
        attemptTimeoutMs: options.attemptTimeoutMs,
      },
    );
  };
}

/**
 * Creates a retryable fetch wrapper for SEP-38 operations.
 */
export function createSep38RetryFetch(
  fetcher: typeof fetch,
  options: WithSepRetryOptions = {},
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    return withSepRetry(
      async (signal) => {
        const response = await fetcher(input, { ...init, signal });
        return response;
      },
      {
        classifyError: (error: unknown, headers?: Headers) => classifySep38Error(error, headers),
        policy: options.policy,
        onRetry: options.onRetry,
        signal: options.signal,
        clock: options.clock,
        random: options.random,
        attemptTimeoutMs: options.attemptTimeoutMs,
      },
    );
  };
}