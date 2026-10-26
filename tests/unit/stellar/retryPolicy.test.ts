import assert from "node:assert/strict";
import test from "node:test";

import { Sep1DiscoveryError } from "@/lib/stellar/sep1";
import { Sep38ClientError } from "@/lib/stellar/sep38";
import {
  calculateSepRetryDelay,
  classifySep1Error,
  classifySep38Error,
  DEFAULT_SEP_RETRY_POLICY,
  isSepDeadlineExceeded,
  parseRetryAfter,
  SepRetryExhaustedError,
  withSepRetry,
  type RetryContext,
  type SepRetryPolicy,
} from "@/lib/stellar/retry";

/** Fixed reference time so every HTTP-date fixture is deterministic. */
const NOW = Date.parse("Wed, 21 Oct 2026 12:00:00 GMT");

/** An HTTP-date exactly 10 seconds after NOW. */
const FUTURE_DATE = "Wed, 21 Oct 2026 12:00:10 GMT";
/** An HTTP-date exactly 10 seconds before NOW. */
const PAST_DATE = "Wed, 21 Oct 2026 11:59:50 GMT";
/** An HTTP-date one hour after NOW, far beyond any sane ceiling. */
const FAR_FUTURE_DATE = "Wed, 21 Oct 2026 13:00:00 GMT";
/** A digit string whose millisecond value overflows IEEE-754 finiteness. */
const OVERFLOW_SECONDS = "9".repeat(400);

const MALFORMED_VALUES = Object.freeze([
  "",
  "   ",
  "soon",
  "later this week",
  "abc",
  "1e3",
  "12abc",
  "3.5",
  "-30",
  "2026-13-45",
  OVERFLOW_SECONDS.slice(0, 30) + ".5",
]);

function headersWith(retryAfter: string | null): Headers {
  const headers = new Headers();
  if (retryAfter !== null) headers.set("retry-after", retryAfter);
  return headers;
}

/** SEP-1 rate-limited failure carrying the upstream response headers. */
class RateLimitedSep1 extends Error {
  readonly code = "HTTP_FAILURE" as const;
  readonly status = 429;
  constructor(readonly responseHeaders?: Headers) {
    super("rate limited");
    this.name = "RateLimitedSep1";
  }
}

/** SEP-38 rate-limited failure carrying the upstream response headers. */
class RateLimitedSep38 extends Error {
  readonly code = "HTTP_FAILURE" as const;
  readonly status = 429;
  constructor(readonly responseHeaders?: Headers) {
    super("rate limited");
    this.name = "RateLimitedSep38";
  }
}

function contextWith(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    attempt: 1,
    deadline: NOW + DEFAULT_SEP_RETRY_POLICY.deadlineMs,
    policy: { ...DEFAULT_SEP_RETRY_POLICY },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseRetryAfter: missing, malformed, numeric, and date-based fixtures
// ---------------------------------------------------------------------------

test("Retry-After parsing falls back when the header is missing or empty", () => {
  assert.equal(parseRetryAfter(undefined, 5_000, NOW), undefined);
  assert.equal(parseRetryAfter(headersWith(null), 5_000, NOW), undefined);
  assert.equal(parseRetryAfter(headersWith(""), 5_000, NOW), undefined);
  assert.equal(parseRetryAfter(headersWith("     "), 5_000, NOW), undefined);
});

test("Retry-After parsing rejects malformed values instead of guessing timing", () => {
  for (const value of MALFORMED_VALUES) {
    assert.equal(
      parseRetryAfter(headersWith(value), 5_000, NOW),
      undefined,
      `expected ${JSON.stringify(value.slice(0, 40))} to fall back safely`,
    );
  }
});

test("Retry-After parsing interprets delay-seconds values", () => {
  // Ceiling deliberately above the fixtures so interpretation, not clamping,
  // is what these assertions observe.
  const ceiling = 60_000;
  assert.equal(parseRetryAfter(headersWith("0"), ceiling, NOW), 0);
  assert.equal(parseRetryAfter(headersWith("3"), ceiling, NOW), 3_000);
  assert.equal(parseRetryAfter(headersWith("  45  "), ceiling, NOW), 45_000);
});

test("Retry-After parsing interprets HTTP-date values against the reference clock", () => {
  assert.equal(parseRetryAfter(headersWith(FUTURE_DATE), 60_000, NOW), 10_000);
  // A past date means "already due" - nothing to honor, so fall back.
  assert.equal(parseRetryAfter(headersWith(PAST_DATE), 5_000, NOW), undefined);
});

test("Retry-After parsing clamps extreme values to the configured ceiling", () => {
  // Numeric far beyond the ceiling.
  assert.equal(parseRetryAfter(headersWith("86400"), 5_000, NOW), 5_000);
  // Date far beyond the ceiling.
  assert.equal(parseRetryAfter(headersWith(FAR_FUTURE_DATE), 5_000, NOW), 5_000);
  // Digit strings that overflow IEEE-754 clamp to the ceiling too.
  assert.equal(parseRetryAfter(headersWith(OVERFLOW_SECONDS), 5_000, NOW), 5_000);
  // Without a ceiling the overflow-grade value falls back instead of becoming
  // an infinite delay.
  assert.equal(parseRetryAfter(headersWith(OVERFLOW_SECONDS), undefined, NOW), undefined);
});

// ---------------------------------------------------------------------------
// Classification: header honored only on 429, safe fallback otherwise
// ---------------------------------------------------------------------------

test("SEP-1 classification honors Retry-After only for rate-limited responses", () => {
  const numeric = classifySep1Error(
    new RateLimitedSep1(headersWith("2")),
    headersWith("2"),
  );
  assert.deepEqual(numeric, {
    classification: "retryable-with-retry-after",
    retryAfterMs: 2_000,
  });

  // Classification runs against the wall clock, so the HTTP-date fixture is
  // generated relative to it; the honored delay must land in (0, 10s].
  const soonDate = new Date(Date.now() + 10_000).toUTCString();
  const dated = classifySep1Error(
    new RateLimitedSep1(headersWith(soonDate)),
    headersWith(soonDate),
  );
  assert.equal(dated.classification, "retryable-with-retry-after");
  assert.ok(
    typeof dated.retryAfterMs === "number" &&
      dated.retryAfterMs > 0 &&
      dated.retryAfterMs <= 10_000,
    `unexpected date-based delay: ${String(dated.retryAfterMs)}`,
  );

  // Missing header: plain retryable, timing decided by backoff.
  assert.deepEqual(
    classifySep1Error(new RateLimitedSep1(headersWith(null)), headersWith(null)),
    { classification: "retryable" },
  );

  // Malformed header: same safe fallback, never a parsed delay.
  assert.deepEqual(
    classifySep1Error(new RateLimitedSep1(headersWith("soon")), headersWith("soon")),
    { classification: "retryable" },
  );

  // Headers absent entirely.
  assert.deepEqual(classifySep1Error(new RateLimitedSep1()), {
    classification: "retryable",
  });

  // 5xx with a Retry-After header: header is ignored for non-429 responses.
  const serverFailure = new Sep1DiscoveryError(
    "HTTP_FAILURE",
    "upstream failed",
    "https://anchor.example/.well-known/stellar.toml",
    { status: 503 },
  );
  assert.deepEqual(
    classifySep1Error(serverFailure, headersWith("600")),
    { classification: "retryable" },
  );

  // Deterministic 4xx is never retried, header or not.
  const notFound = new Sep1DiscoveryError(
    "HTTP_FAILURE",
    "not found",
    "https://anchor.example/.well-known/stellar.toml",
    { status: 404 },
  );
  assert.deepEqual(
    classifySep1Error(notFound, headersWith("1")),
    { classification: "non-retryable" },
  );
});

test("SEP-1 classification never retries malformed protocol data", () => {
  for (const code of [
    "INVALID_HOME_DOMAIN",
    "INVALID_TOML",
    "INVALID_DATA",
    "MISSING_REQUIRED_DATA",
    "RESPONSE_TOO_LARGE",
  ] as const) {
    const error = new Sep1DiscoveryError(
      code,
      "broken",
      "https://anchor.example/.well-known/stellar.toml",
    );
    assert.deepEqual(
      classifySep1Error(error, headersWith("120")),
      { classification: "non-retryable" },
      `${code} must not be retried`,
    );
  }

  assert.deepEqual(classifySep1Error(new Error("surprise"), headersWith("1")), {
    classification: "non-retryable",
  });
});

test("SEP-38 classification honors Retry-After only for rate-limited responses", () => {
  const numeric = classifySep38Error(
    new RateLimitedSep38(headersWith("5")),
    headersWith("5"),
  );
  assert.deepEqual(numeric, {
    classification: "retryable-with-retry-after",
    retryAfterMs: 5_000,
  });

  assert.deepEqual(
    classifySep38Error(new RateLimitedSep38(headersWith("nope")), headersWith("nope")),
    { classification: "retryable" },
  );

  const auth = new Sep38ClientError(
    "AUTHENTICATION_REQUIRED",
    "auth required",
    "https://anchor.example/sep38",
  );
  assert.deepEqual(classifySep38Error(auth, headersWith("120")), {
    classification: "non-retryable",
  });

  const invalidJson = new Sep38ClientError(
    "INVALID_JSON",
    "bad json",
    "https://anchor.example/sep38",
  );
  assert.deepEqual(classifySep38Error(invalidJson, headersWith("120")), {
    classification: "non-retryable",
  });
});

// ---------------------------------------------------------------------------
// Delay math: Retry-After bounded by maxRetryAfterMs, backoff by maxDelayMs
// ---------------------------------------------------------------------------

test("Retry-After delays are bounded by the configured Retry-After ceiling", () => {
  const policy: SepRetryPolicy = { ...DEFAULT_SEP_RETRY_POLICY };
  const atCeiling = calculateSepRetryDelay(
    contextWith({ retryAfterMs: policy.maxRetryAfterMs + 30_000 }),
  );
  assert.equal(atCeiling, policy.maxRetryAfterMs);

  const within = calculateSepRetryDelay(contextWith({ retryAfterMs: 1_500 }));
  assert.equal(within, 1_500);

  const negative = calculateSepRetryDelay(contextWith({ retryAfterMs: -50 }));
  assert.equal(negative, 0);
});

test("backoff delays stay within [delay/2, maxDelayMs] for any jitter draw", () => {
  const policy: SepRetryPolicy = { ...DEFAULT_SEP_RETRY_POLICY };

  // Jitter extremes: random() = 0 gives half, random() = 1 gives the full delay.
  const low = calculateSepRetryDelay(contextWith({ attempt: 1 }), () => 0);
  const high = calculateSepRetryDelay(contextWith({ attempt: 1 }), () => 1);
  assert.equal(low, Math.floor(policy.baseDelayMs / 2));
  assert.equal(high, policy.baseDelayMs);

  // Growth then cap: delays never exceed maxDelayMs even at random() = 1.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const delay = calculateSepRetryDelay(contextWith({ attempt }), () => 1);
    const ceiling = Math.min(
      policy.baseDelayMs * Math.pow(2, attempt - 1),
      policy.maxDelayMs,
    );
    assert.equal(delay, ceiling);
    assert.ok(delay <= policy.maxDelayMs, `attempt ${attempt} exceeded maxDelayMs`);
  }
});

test("the deadline check uses the caller's clock", () => {
  const context = contextWith({ deadline: NOW + 1_000 });
  assert.equal(isSepDeadlineExceeded(context, NOW), false);
  assert.equal(isSepDeadlineExceeded(context, NOW + 999), false);
  assert.equal(isSepDeadlineExceeded(context, NOW + 1_000), true);
});

// ---------------------------------------------------------------------------
// withSepRetry: bounded timing, cancellation, and overall deadlines
// ---------------------------------------------------------------------------

test("retries a rate-limited failure using a valid numeric Retry-After delay", async () => {
  let calls = 0;

  const started = Date.now();
  const result = await withSepRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new RateLimitedSep1(headersWith("1"));
      return "recovered";
    },
    {
      // Backoff would take at most maxDelayMs (50ms); a honored Retry-After
      // of "1" second must produce a ~1000ms sleep instead.
      policy: { baseDelayMs: 5, maxDelayMs: 50, maxRetryAfterMs: 5_000 },
      random: () => 1,
      classifyError: (error, headers) => classifySep1Error(error, headers),
    },
  );
  const elapsed = Date.now() - started;

  assert.equal(result, "recovered");
  assert.equal(calls, 2);
  assert.ok(elapsed >= 900, `Retry-After delay was not honored (took ${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `Retry-After delay exceeded its bound (took ${elapsed}ms)`);
});

test("a malformed Retry-After falls back to bounded backoff timing", async () => {
  let calls = 0;

  const started = Date.now();
  await withSepRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new RateLimitedSep1(headersWith("soon"));
      return "ok";
    },
    {
      policy: { baseDelayMs: 20, maxDelayMs: 40, maxRetryAfterMs: 5_000 },
      random: () => 1,
      classifyError: (error, headers) => classifySep1Error(error, headers),
    },
  );
  const elapsed = Date.now() - started;

  assert.equal(calls, 2);
  // The unparseable header must not become timing: the retry waits only the
  // bounded backoff delay (20ms at random() = 1), never a multi-second guess.
  assert.ok(elapsed < 5_000, `fallback took too long: ${elapsed}ms`);
});

test("retries honor cancellation during a Retry-After sleep", async () => {
  const controller = new AbortController();
  const policy: SepRetryPolicy = {
    ...DEFAULT_SEP_RETRY_POLICY,
    maxRetryAfterMs: 30_000,
    maxDelayMs: 30_000,
  };
  let calls = 0;

  const started = Date.now();
  const pending = withSepRetry(
    async () => {
      calls += 1;
      throw new RateLimitedSep1(headersWith("30"));
    },
    {
      policy,
      signal: controller.signal,
      classifyError: (error, headers) => classifySep1Error(error, headers),
    },
  );

  // Let the first failure schedule its 30s Retry-After sleep, then abort.
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
    return true;
  });

  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 5_000,
    `cancellation must interrupt the sleep promptly, took ${elapsed}ms`,
  );
  assert.equal(calls, 1, "no attempt may start after cancellation");
});

test("retries never sleep past the overall job deadline", async () => {
  const policy: SepRetryPolicy = {
    ...DEFAULT_SEP_RETRY_POLICY,
    deadlineMs: 120,
    maxRetryAfterMs: 30_000,
    maxDelayMs: 30_000,
  };
  let calls = 0;

  const started = Date.now();
  await assert.rejects(
    withSepRetry(
      async () => {
        calls += 1;
        // Valid Retry-After far beyond the job deadline must not be honored
        // past it: the deadline aborts the sleep.
        throw new RateLimitedSep1(headersWith("30"));
      },
      {
        policy,
        classifyError: (error, headers) => classifySep1Error(error, headers),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "AbortError");
      return true;
    },
  );

  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 5_000,
    `deadline must bound the retry, took ${elapsed}ms`,
  );
  assert.equal(calls, 1, "no attempt may start after the deadline");
});

test("surfaces the original error when the attempt budget is exhausted", async () => {
  let calls = 0;

  await assert.rejects(
    withSepRetry(
      async () => {
        calls += 1;
        throw new RateLimitedSep1(headersWith(null));
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
        random: () => 0,
        classifyError: (error, headers) => classifySep1Error(error, headers),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SepRetryExhaustedError);
      assert.equal(error.attempts, 3);
      assert.ok(error.lastError instanceof RateLimitedSep1);
      return true;
    },
  );

  assert.equal(calls, 3);
});

test("surfaces non-retryable failures immediately without consuming retries", async () => {
  let calls = 0;

  await assert.rejects(
    withSepRetry(
      async () => {
        calls += 1;
        throw new Sep38ClientError(
          "INVALID_JSON",
          "bad json",
          "https://anchor.example/sep38",
        );
      },
      {
        policy: { maxAttempts: 3 },
        classifyError: (error, headers) => classifySep38Error(error, headers),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Sep38ClientError);
      assert.equal(error.code, "INVALID_JSON");
      return true;
    },
  );

  assert.equal(calls, 1);
});
