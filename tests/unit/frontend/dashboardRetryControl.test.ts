import assert from "node:assert/strict";
import test from "node:test";

import {
  type DashboardFailure,
  makeDashboardApiError,
  makeDashboardApiResult,
  withRecoverableErrors,
} from "@/lib/dashboard/DashboardApiStubs";
import {
  isPublicApiResultRecoverable,
  RECOVERABLE_PUBLIC_API_ERROR_CODES,
} from "@/types/api/errors";

test("recoverable error codes are a closed set used by dashboard retry controls", () => {
  assert.ok(Array.isArray(RECOVERABLE_PUBLIC_API_ERROR_CODES));
  assert.ok(RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("internal_error"));
  assert.ok(RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("upstream_unavailable"));
  assert.ok(RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("rate_limited"));
  assert.ok(!RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("corridor_not_found"));
  assert.ok(!RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("anchor_not_found"));
  assert.ok(!RECOVERABLE_PUBLIC_API_ERROR_CODES.includes("missing_corridor"));
});

test("isPublicApiResultRecoverable only matches recoverable dashboard failures", () => {
  const recoverable = makeDashboardApiError({
    code: "internal_error",
    message: "Unable to read rates.",
  });

  const notRecoverable = makeDashboardApiError({
    code: "corridor_not_found",
    message: "Corridor not found.",
  });

  assert.equal(isPublicApiResultRecoverable(recoverable), true);
  assert.equal(isPublicApiResultRecoverable(notRecoverable), false);
  assert.equal(isPublicApiResultRecoverable({ status: 200, body: { ok: true } }), false);
  assert.equal(isPublicApiResultRecoverable(null), false);
  assert.equal(isPublicApiResultRecoverable(undefined), false);
  assert.equal(isPublicApiResultRecoverable("nope"), false);
});

test("withRecoverableErrors preserves success states between recoverable failures", async () => {
  const body = { items: ["a", "b"] };
  const sequence = [
    makeDashboardApiResult(200, body),
    { code: "internal_error" as const, message: "boom" } satisfies DashboardFailure,
    makeDashboardApiResult(200, body),
  ];

  const results = await withRecoverableErrors(sequence);

  assert.equal(results.length, 3);
  assert.deepEqual(results[0], makeDashboardApiResult(200, body));
  assert.equal(results[1].status, 500);
  assert.equal(results[1].body.error.code, "internal_error");
  assert.deepEqual(results[2], makeDashboardApiResult(200, body));
});

test("retry controls should only appear for recoverable panels, not terminal API errors", async () => {
  const recoverableResult = makeDashboardApiError({
    code: "upstream_unavailable",
    message: "Upstream unavailable.",
  });

  const terminalResult = makeDashboardApiError({
    code: "anchor_not_found",
    message: "Anchor not found.",
  });

  assert.equal(isPublicApiResultRecoverable(recoverableResult), true);
  assert.equal(isPublicApiResultRecoverable(terminalResult), false);
});

test("repeated retry calls do not create uncontrolled concurrent requests", async () => {
  let attempted = 0;

  const load = async (): Promise<{ status: 200; body: { ok: true } }> => {
    ++attempted;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: 200, body: { ok: true } };
  };

  const first = load();
  const second = load();
  const third = load();

  const sequence = await Promise.all([first, second, third]);

  assert.equal(attempted, 3);
  assert.equal(sequence.length, 3);
  for (const result of sequence) {
    assert.deepEqual(result, {
      status: 200,
      body: { ok: true },
    });
  }
});

test("success after retry clears the panel error state", async () => {
  const failedOnce = makeDashboardApiError({
    code: "rate_limited",
    message: "Too many requests.",
  });

  const recovered = makeDashboardApiResult(200, { rate: "5.20" });

  const results = await withRecoverableErrors([
    failedOnce,
    recovered,
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 429);
  assert.equal(results[0].body.error.code, "rate_limited");
  assert.deepEqual(results[1], recovered);
});

test("sibling success results are unchanged when one panel is retried", async () => {
  const anchorsBody = { anchors: ["Acme Anchor"] };
  const ratesBody = { corridor: "usdc-us-brl-br", medianRate: "5.20" };

  const stubs = await withRecoverableErrors<unknown>([
    makeDashboardApiResult(200, anchorsBody),
    makeDashboardApiError({ code: "internal_error", message: "Transient rates failure." }),
    makeDashboardApiResult(200, ratesBody),
  ]);

  assert.deepEqual(stubs[0], makeDashboardApiResult(200, anchorsBody));
  assert.equal(stubs[1].status, 500);
  assert.equal(stubs[1].body.error.code, "internal_error");
  assert.deepEqual(stubs[2], makeDashboardApiResult(200, ratesBody));
});
