/**
 * Bounded retry budgets with exponential backoff and jitter for upstream SEP
 * operations (#166), with regression-hardened Retry-After parsing (#449).
 *
 * Policy:
 * - Classifies SEP-1 and SEP-38 failures as retryable or non-retryable.
 *   Malformed protocol data, validation failures, authentication failures,
 *   redirects, and non-429/5xx HTTP responses are never retried.
 * - Interprets an upstream `Retry-After` header (delay-seconds or HTTP-date)
 *   only where the current policy honors it: 429 responses. Every value is
 *   clamped to the configured `maxRetryAfterMs` ceiling, so an extreme or
 *   hostile header can never produce an unbounded delay.
 * - Missing or malformed headers fall back safely to jittered exponential
 *   backoff; an unparseable header never becomes retry timing.
 * - Enforces an overall deadline and external cancellation across attempts,
 *   retry sleeps, and the callback's AbortSignal: retries cannot outlive the
 *   job that spawned them or bypass an abort.
 * - Deterministic under test via injected clock, randomness, and a fixed
 *   `now` for HTTP-date headers.
 */

import type { Sep1ErrorCode } from "@/lib/stellar/sep1";
import type { Sep38ErrorCode } from "@/lib/stellar/sep38";

/** Retry policy configuration for SEP operations. */
export interface SepRetryPolicy {
  /** Maximum number of attempts (initial + retries). Default: 3. */
  maxAttempts: number;
  /** Base delay in milliseconds for exponential backoff. Default: 100ms. */
  baseDelayMs: number;
  /** Maximum backoff delay cap in milliseconds. Default: 2000ms. */
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
  /** Optional validated Retry-After value in ms, already capped by the policy. */
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
  /** Set only for "retryable-with-retry-after": the parsed Retry-After delay in ms. */
  retryAfterMs?: number;
}

/** RFC 7231 delay-seconds is 1*DIGIT; anything else is not a delay-seconds value. */
const DELAY_SECONDS_PATTERN = /^\d+$/;

/**
 * Parses a `Retry-After` header into milliseconds under the current policy.
 *
 * Supported values:
 * - delay-seconds (`"120"`) -> `120_000` ms.
 * - HTTP-date (`"Wed, 21 Oct 2027 07:28:00 GMT"`) -> delta from `now`,
 *   only when the date is in the future.
 *
 * Both forms are clamped to `maxRetryAfterMs` when a ceiling is supplied, so
 * extreme values are bounded rather than trusted.
 *
 * Returns `undefined` when the header is missing, empty, malformed, expressed
 * as a past date, or (for overflow-grade digit strings) no ceiling is
 * configured. An `undefined` result means "fall back to backoff"; it is never
 * a delay on its own.
 */
export function parseRetryAfter(
  headers?: Headers,
  maxRetryAfterMs?: number,
  now: number = Date.now(),
): number | undefined {
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined) return undefined;

  const value = raw.trim();
  if (value === "") return undefined;

  // Strict delay-seconds: reject "1e3", "12abc", "-30", "3.5", and friends
  // instead of letting Number.parseInt silently reinterpret them.
  if (DELAY_SECONDS_PATTERN.test(value)) {
    const ms = Number(value) * 1000;
    return clampRetryAfterMs(ms, maxRetryAfterMs);
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;

  const deltaMs = dateMs - now;
  if (deltaMs <= 0) return undefined;

  return clampRetryAfterMs(deltaMs, maxRetryAfterMs);
}

/**
 * Clamps a candidate delay to the configured ceiling.
 * Non-finite results (digit strings beyond IEEE-754 range) clamp to the
 * ceiling, or fall back to `undefined` when no ceiling is configured.
 */
function clampRetryAfterMs(ms: number, maxRetryAfterMs?: number): number | undefined {
  if (!Number.isFinite(ms)) return maxRetryAfterMs;
  if (maxRetryAfterMs === undefined) return ms;
  return Math.min(ms, maxRetryAfterMs);
}

/**
 * Determines if a SEP-1 error is retryable.
 *
 * Retryable: TIMEOUT, NETWORK_FAILURE, HTTP_FAILURE (5xx and 429),
 *   EGRESS_POLICY.
 * Non-retryable: INVALID_HOME_DOMAIN, INVALID_TOML, INVALID_DATA,
 *   MISSING_REQUIRED_DATA, RESPONSE_TOO_LARGE, HTTP_FAILURE (other 4xx),
 *   unknown errors.
 *
 * A `Retry-After` header is consulted only for 429 responses; on any other
 * status it is ignored.
 */
export function classifySep1Error(
  error: unknown,
  responseHeaders?: Headers,
): ErrorClassificationResult {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: Sep1ErrorCode }).code;

    if (
      code === "INVALID_HOME_DOMAIN" ||
      code === "INVALID_TOML" ||
      code === "INVALID_DATA" ||
      code === "MISSING_REQUIRED_DATA" ||
      code === "RESPONSE_TOO_LARGE"
    ) {
      return { classification: "non-retryable" };
    }

    if (code === "HTTP_FAILURE") {
      return classifyHttpFailure(error, responseHeaders);
    }

    if (code === "EGRESS_POLICY" || code === "TIMEOUT" || code === "NETWORK_FAILURE") {
      return { classification: "retryable" };
    }
  }

  // Unknown errors - be conservative and don't retry.
  return { classification: "non-retryable" };
}

/**
 * Determines if a SEP-38 error is retryable.
 *
 * Retryable: TIMEOUT, NETWORK_FAILURE, HTTP_FAILURE (5xx and 429),
 *   EGRESS_POLICY.
 * Non-retryable: INVALID_ASSET, INVALID_QUOTE_SERVER, INVALID_REQUEST,
 *   AUTHENTICATION_REQUIRED, REDIRECT, RESPONSE_TOO_LARGE,
 *   INVALID_CONTENT_TYPE, INVALID_JSON, INVALID_DATA,
 *   HTTP_FAILURE (other 4xx), unknown errors.
 *
 * A `Retry-After` header is consulted only for 429 responses; on any other
 * status it is ignored.
 */
export function classifySep38Error(
  error: unknown,
  responseHeaders?: Headers,
): ErrorClassificationResult {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code: Sep38ErrorCode }).code;

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

    if (code === "HTTP_FAILURE") {
      return classifyHttpFailure(error, responseHeaders);
    }

    if (code === "EGRESS_POLICY" || code === "TIMEOUT" || code === "NETWORK_FAILURE") {
      return { classification: "retryable" };
    }
  }

  // Unknown errors - be conservative and don't retry.
  return { classification: "non-retryable" };
}

/** Shared HTTP_FAILURE policy: honor Retry-After on 429, retry 5xx, drop 4xx. */
function classifyHttpFailure(
  error: Error,
  responseHeaders?: Headers,
): ErrorClassificationResult {
  const status = (error as { status?: number }).status;

  if (status === 429) {
    // Rate limited - honor a well-formed Retry-After when present. Missing or
    // malformed headers fall back to plain retryable (jittered backoff).
    const retryAfterMs = parseRetryAfter(responseHeaders);
    if (retryAfterMs !== undefined) {
      return { classification: "retryable-with-retry-after", retryAfterMs };
    }
    return { classification: "retryable" };
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return { classification: "retryable" };
  }

  // Remaining 4xx (and status-less failures) are deterministic - don't retry.
  return { classification: "non-retryable" };
}

/**
 * Calculates the delay for the next retry attempt.
 *
 * - When the upstream supplied a validated Retry-After delay, that delay is
 *   used, clamped to `policy.maxRetryAfterMs` (the configured ceiling for
 *   server-requested timing).
 * - Otherwise exponential backoff with jitter:
 *   `min(baseDelayMs * 2^(attempt-1), maxDelayMs) * (0.5 + random() * 0.5)`,
 *   which stays within `[delay/2, delay]` and never exceeds `maxDelayMs` for
 *   `random()` in `[0, 1]`.
 */
export function calculateSepRetryDelay(
  context: RetryContext,
  random: () => number = Math.random,
): number {
  const { attempt, policy, retryAfterMs } = context;

  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 0), policy.maxRetryAfterMs);
  }

  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs);
  const jitter = 0.5 + 0.5 * random();
  return Math.floor(cappedDelay * jitter);
}

/**
 * Checks if the retry deadline has been exceeded, using the caller's clock so
 * injected test clocks stay consistent with the computed deadline.
 */
export function isSepDeadlineExceeded(
  context: RetryContext,
  now: number = Date.now(),
): boolean {
  return now >= context.deadline;
}

/** Options for withSepRetry. */
export interface WithSepRetryOptions {
  /** Retry policy configuration. */
  policy?: Partial<SepRetryPolicy>;
  /** Called before each retry sleep with the error and attempt number. */
  onRetry?: (error: Error, attempt: number) => void;
  /** Optional abort signal to propagate cancellation. */
  signal?: AbortSignal;
  /** For tests: injected clock function returning current time in ms. */
  clock?: () => number;
  /** For tests: injected random function for jitter. */
  random?: () => number;
  /** Function to classify errors as retryable/non-retryable. */
  classifyError: (error: unknown, responseHeaders?: Headers) => ErrorClassificationResult;
  /** Optional custom timeout per attempt. */
  attemptTimeoutMs?: number;
}

/**
 * Executes a callback with bounded retry logic for upstream SEP operations.
 *
 * @param callback - Performs one attempt. Receives an AbortSignal combining the
 *   external signal (if any) with the internal deadline signal.
 * @param options - Retry configuration, including the error classifier.
 * @returns The first successful result.
 * @throws The original error when it is non-retryable or when no retry was
 *   attempted, `SepRetryExhaustedError` when the attempt budget runs out, and
 *   an `AbortError` when cancellation or the overall deadline fires. A retry
 *   can therefore never outlive its job.
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

  const policy: SepRetryPolicy = {
    ...DEFAULT_SEP_RETRY_POLICY,
    ...userPolicy,
  };

  const deadline = clock() + policy.deadlineMs;
  const controller = new AbortController();
  const internalSignal = controller.signal;
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, internalSignal])
    : internalSignal;

  // Deadline enforcement: fires even if the callback hangs.
  const deadlineTimeout = setTimeout(() => controller.abort(), policy.deadlineMs);

  try {
    for (let attempt = 1; ; attempt += 1) {
      const context: RetryContext = { attempt, deadline, policy };

      let result: T;
      try {
        result = await runAttempt(callback, signal, attemptTimeoutMs);
      } catch (error) {
        const lastError = error instanceof Error ? error : new Error(String(error));

        // Cancellation (external or deadline) always wins over retrying.
        if (signal.aborted || isAbortError(lastError)) {
          throw abortReason(signal, lastError);
        }

        const classification = classifyError(
          lastError,
          responseHeadersFrom(lastError),
        );

        // Deterministic failures fail immediately.
        if (classification.classification === "non-retryable") {
          throw lastError;
        }

        // Attempt or deadline budget exhausted.
        if (attempt >= policy.maxAttempts || isSepDeadlineExceeded(context, clock())) {
          if (attempt <= 1) {
            // Nothing was ever retried - surface the original failure.
            throw lastError;
          }
          throw new SepRetryExhaustedError(attempt, lastError, policy.deadlineMs);
        }

        if (classification.classification === "retryable-with-retry-after") {
          // Re-clamp against the active policy: callers may pass raw values.
          context.retryAfterMs = Math.min(
            Math.max(classification.retryAfterMs ?? 0, 0),
            policy.maxRetryAfterMs,
          );
        }

        onRetry?.(lastError, attempt);

        // The sleep itself is abortable, so cancellation and the deadline
        // interrupt waiting just as they interrupt the callback.
        await sleepWithAbort(calculateSepRetryDelay(context, random), signal);
        continue;
      }

      return result;
    }
  } finally {
    clearTimeout(deadlineTimeout);
  }
}

/** Runs one attempt, optionally bounded by a per-attempt timeout. */
async function runAttempt<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  attemptTimeoutMs?: number,
): Promise<T> {
  if (attemptTimeoutMs === undefined) return callback(signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      callback(signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Attempt timeout")), attemptTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolves after `ms`, rejecting with an AbortError as soon as `signal` fires. */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortReason(signal: AbortSignal, fallback?: unknown): DOMException {
  if (signal.aborted && signal.reason instanceof DOMException) return signal.reason;
  if (isAbortError(fallback)) return fallback as DOMException;
  return new DOMException("Aborted", "AbortError");
}

/**
 * Reads upstream response headers off a thrown error when the producer
 * attached them (`responseHeaders`), so Retry-After from a 429 response can
 * reach classification. Errors without headers simply classify as if the
 * header were missing.
 */
function responseHeadersFrom(error: unknown): Headers | undefined {
  if (!(error instanceof Error) || !("responseHeaders" in error)) return undefined;
  const headers = (error as { responseHeaders?: unknown }).responseHeaders;
  return headers instanceof Headers ? headers : undefined;
}

/** Error thrown when the retry budget is exhausted. */
export class SepRetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: Error,
    readonly deadlineMs: number,
  ) {
    super(
      `SEP retry exhausted after ${attempts} attempts within ${deadlineMs}ms: ${lastError.message}`,
      { cause: lastError },
    );
    this.name = "SepRetryExhaustedError";
  }
}
