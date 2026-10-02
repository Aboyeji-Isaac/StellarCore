import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import {
  RequestCancelledError,
  createRequestContext,
  isRequestCancellationError,
  requestCancelledResponse,
  runWithinContext,
  withRequestContext,
} from "@/lib/api/requestContext";
import type { RequestContext } from "@/types/api/requestContext";

test("an unexpired budget stays active and never aborts its signal", () => {
  const context = createRequestContext({ budgetMs: 2_500, now: () => 1_000 });

  assert.equal(context.cancellationReason(), null);
  assert.equal(context.signal.aborted, false);
  assert.doesNotThrow(() => context.assertActive());

  context.dispose();
});

test("the deadline expires exactly at the budget boundary", () => {
  let current = 1_000;
  const context = createRequestContext({ budgetMs: 250, now: () => current });

  current = 1_249;
  assert.equal(context.cancellationReason(), null);

  current = 1_250;
  assert.equal(context.cancellationReason(), "deadline_exceeded");
  assert.equal(context.signal.aborted, true);
  assert.throws(
    () => context.assertActive(),
    (error: unknown) => isRequestCancellationError(error)
      && error.reason === "deadline_exceeded",
  );

  context.dispose();
});

test("a disconnecting caller cancels before the deadline is reached", () => {
  const caller = new AbortController();
  const context = createRequestContext({
    budgetMs: 5_000,
    signal: caller.signal,
    now: () => 0,
  });

  caller.abort();

  assert.equal(context.cancellationReason(), "client_aborted");
  assert.equal(context.signal.aborted, true);
  assert.throws(
    () => context.assertActive(),
    (error: unknown) => isRequestCancellationError(error)
      && error.reason === "client_aborted",
  );

  context.dispose();
});

test("an already disconnected caller never starts downstream work", async () => {
  const caller = new AbortController();
  caller.abort();
  const context = createRequestContext({ budgetMs: 5_000, signal: caller.signal });

  assert.equal(context.cancellationReason(), "client_aborted");

  let started = false;
  await assert.rejects(
    context.run(async () => {
      started = true;
      return "value";
    }),
    RequestCancelledError,
  );
  assert.equal(started, false);

  context.dispose();
});

test("the first cancellation cause wins when both races fire", () => {
  const callerFirst = new AbortController();
  let clock = 0;
  const clientWins = createRequestContext({
    budgetMs: 100,
    signal: callerFirst.signal,
    now: () => clock,
  });
  callerFirst.abort();
  clock = 1_000;
  assert.equal(clientWins.cancellationReason(), "client_aborted");
  clientWins.dispose();

  const deadlineFirst = new AbortController();
  clock = 0;
  const deadlineWins = createRequestContext({
    budgetMs: 100,
    signal: deadlineFirst.signal,
    now: () => clock,
  });
  clock = 100;
  assert.equal(deadlineWins.cancellationReason(), "deadline_exceeded");
  deadlineFirst.abort();
  assert.equal(deadlineWins.cancellationReason(), "deadline_exceeded");
  deadlineWins.dispose();
});

test("work already in flight stops waiting when the budget expires", async () => {
  let clock = 0;
  const context = createRequestContext({ budgetMs: 50, now: () => clock });
  // Assigned synchronously when the statement promise is constructed.
  let complete!: (value: string) => void;

  const pending = context.run(() => new Promise<string>((resolve) => {
    complete = resolve;
  }));

  clock = 50;
  assert.equal(context.cancellationReason(), "deadline_exceeded");
  await assert.rejects(
    pending,
    (error: unknown) => isRequestCancellationError(error)
      && error.reason === "deadline_exceeded",
  );

  // The statement still finishes later; its outcome is discarded, not rethrown.
  complete("late value");
  await Promise.resolve();
  assert.equal(context.cancellationReason(), "deadline_exceeded");

  context.dispose();
});

test("a statement failing after cancellation cannot surface as an unhandled rejection", async () => {
  let clock = 0;
  const context = createRequestContext({ budgetMs: 10, now: () => clock });
  // Assigned synchronously when the statement promise is constructed.
  let fail!: (error: Error) => void;

  const pending = context.run(() => new Promise<string>((_resolve, reject) => {
    fail = reject;
  }));

  clock = 10;
  await assert.rejects(pending, RequestCancelledError);

  fail(new Error("statement failed after the response was sent"));
  await Promise.resolve();

  context.dispose();
});

test("work completing inside the budget resolves unchanged", async () => {
  const context = createRequestContext({ budgetMs: 1_000, now: () => 0 });

  assert.equal(await context.run(async () => "completed"), "completed");
  assert.equal(context.cancellationReason(), null);

  context.dispose();
});

test("the pending budget fires on its own without an explicit observation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = createRequestContext({ budgetMs: 1_000 });

  t.mock.timers.tick(999);
  assert.equal(context.signal.aborted, false);

  t.mock.timers.tick(1);
  assert.equal(context.signal.aborted, true);
  assert.equal(context.cancellationReason(), "deadline_exceeded");

  context.dispose();
});

test("dispose releases the caller listener and the pending budget timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  const context = createRequestContext({
    budgetMs: 1_000,
    signal: caller.signal,
  });

  assert.equal(getEventListeners(caller.signal, "abort").length, 1);

  context.dispose();

  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  t.mock.timers.tick(10_000);
  assert.equal(context.signal.aborted, false);
  assert.equal(context.cancellationReason(), null);
});

test("dispose is idempotent and leaves a finished request inert", () => {
  const caller = new AbortController();
  const context = createRequestContext({
    budgetMs: 1_000,
    signal: caller.signal,
    now: () => 0,
  });

  context.dispose();
  context.dispose();
  caller.abort();

  assert.equal(context.cancellationReason(), null);
  assert.doesNotThrow(() => context.assertActive());
});

test("a budget that is not a positive finite number fails closed", () => {
  for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const context = createRequestContext({ budgetMs, now: () => 5_000 });

    assert.equal(
      context.cancellationReason(),
      "deadline_exceeded",
      `budget ${String(budgetMs)}`,
    );
    assert.equal(context.signal.aborted, true);

    context.dispose();
  }
});

test("bounded work is optional so non-request callers stay unbounded", async () => {
  assert.equal(await runWithinContext(undefined, async () => "unbounded"), "unbounded");

  const context = createRequestContext({ budgetMs: 1_000, now: () => 0 });
  assert.equal(await runWithinContext(context, async () => "bounded"), "bounded");
  context.dispose();
});

test("deadline expiry maps to a retryable 503 with a bounded envelope", async () => {
  const response = requestCancelledResponse("deadline_exceeded");

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), {
    error: {
      code: "request_deadline_exceeded",
      message: "The request could not be completed within its time budget.",
    },
  });
});

test("a disconnected caller receives no serialized body", async () => {
  const response = requestCancelledResponse("client_aborted");

  assert.equal(response.status, 499);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(await response.text(), "");
});

test("the route wrapper passes a successful response through untouched", async () => {
  const response = await withRequestContext(
    { signal: new AbortController().signal },
    1_000,
    async () => Response.json({ ok: true }, { status: 200 }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the route wrapper maps a cancelled handler to the documented response", async () => {
  const caller = new AbortController();
  caller.abort();

  const response = await withRequestContext({ signal: caller.signal }, 1_000, async (context) => {
    context.assertActive();
    return Response.json({ ok: true }, { status: 200 });
  });

  assert.equal(response.status, 499);
  assert.equal(await response.text(), "");
});

test("the route wrapper reports an expired budget while a statement is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const response = await withRequestContext(
    { signal: new AbortController().signal },
    1_000,
    async (context) => {
      const pending = context.run(() => new Promise<Response>(() => {}));
      t.mock.timers.tick(1_000);
      return pending;
    },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), {
    error: {
      code: "request_deadline_exceeded",
      message: "The request could not be completed within its time budget.",
    },
  });
});

test("the route wrapper rethrows failures that are not cancellations", async () => {
  await assert.rejects(
    withRequestContext({ signal: new AbortController().signal }, 1_000, async () => {
      throw new Error("unexpected repository failure");
    }),
    /unexpected repository failure/,
  );
});

test("the route wrapper disposes the context it created", async () => {
  const caller = new AbortController();
  let captured: RequestContext | undefined;

  await withRequestContext({ signal: caller.signal }, 1_000, async (context) => {
    captured = context;
    return new Response(null, { status: 204 });
  });

  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(captured?.cancellationReason(), null);
});
