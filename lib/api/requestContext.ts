import type {
  RequestCancellationReason,
  RequestContext,
  RequestDeadlineExceededResponse,
} from "@/types/api/requestContext";

/**
 * nginx-style "client closed request". The caller is already gone, so this
 * status only reaches server logs and keeps client hangups out of the 5xx
 * signals that deadline expiry reports.
 */
const CLIENT_CLOSED_REQUEST_STATUS = 499;
const DEADLINE_EXCEEDED_STATUS = 503;
const RETRY_AFTER_SECONDS = 1;

export class RequestCancelledError extends Error {
  readonly reason: RequestCancellationReason;

  constructor(reason: RequestCancellationReason) {
    super(reason === "deadline_exceeded"
      ? "Request exceeded its end-to-end deadline"
      : "Request was cancelled by the caller");
    this.name = "RequestCancelledError";
    this.reason = reason;
  }
}

export function isRequestCancellationError(
  value: unknown,
): value is RequestCancelledError {
  return value instanceof RequestCancelledError;
}

export type CreateRequestContextOptions = Readonly<{
  budgetMs: number;
  signal?: AbortSignal | undefined;
  now?: () => number;
}>;

/**
 * Composes the caller's disconnect signal with one end-to-end deadline for the
 * whole request. The first cause wins and is never overwritten, so a deadline
 * that expires while a client hangup is still propagating keeps a stable
 * reason. A budget that is not a positive finite number fails closed.
 */
export function createRequestContext(
  options: CreateRequestContextOptions,
): RequestContext {
  const now = options.now ?? Date.now;
  const caller = options.signal;
  const controller = new AbortController();
  const startedAt = now();
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0
    ? options.budgetMs
    : 0;
  const deadlineAt = startedAt + budgetMs;

  let failure: RequestCancelledError | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function cancel(reason: RequestCancellationReason): void {
    if (failure !== null || disposed) return;
    failure = new RequestCancelledError(reason);
    controller.abort(failure);
  }

  // Reading cancellation state also aborts `signal`, so a deadline reached
  // between timer ticks is visible to every holder of the same context.
  function observe(): RequestCancelledError | null {
    if (failure === null && !disposed) {
      if (caller?.aborted) cancel("client_aborted");
      else if (now() >= deadlineAt) cancel("deadline_exceeded");
    }
    return failure;
  }

  function onCallerAbort(): void {
    cancel("client_aborted");
  }

  if (caller?.aborted) {
    cancel("client_aborted");
  } else {
    caller?.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(() => cancel("deadline_exceeded"), budgetMs);
    // The budget must never hold the process open after a response is sent.
    (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
  }

  return Object.freeze({
    signal: controller.signal,

    cancellationReason(): RequestCancellationReason | null {
      return observe()?.reason ?? null;
    },

    assertActive(): void {
      const current = observe();
      if (current !== null) throw current;
    },

    run<T>(work: () => Promise<T>): Promise<T> {
      const existing = observe();
      if (existing !== null) return Promise.reject(existing);

      return new Promise<T>((resolve, reject) => {
        let settled = false;

        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          reject(observe() ?? new RequestCancelledError("deadline_exceeded"));
        };

        controller.signal.addEventListener("abort", onAbort, { once: true });

        // The losing branch stays handled so a statement that outlives the
        // request cannot surface as an unhandled rejection.
        work().then(
          (value) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      caller?.removeEventListener("abort", onCallerAbort);
    },
  });
}

export function runWithinContext<T>(
  context: RequestContext | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return context ? context.run(work) : work();
}

export function requestCancelledResponse(
  reason: RequestCancellationReason,
): Response {
  if (reason === "client_aborted") {
    // Nobody is left to receive a body, so serialization is skipped entirely.
    return new Response(null, {
      status: CLIENT_CLOSED_REQUEST_STATUS,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const body: RequestDeadlineExceededResponse = Object.freeze({
    error: Object.freeze({
      code: "request_deadline_exceeded",
      message: "The request could not be completed within its time budget.",
    }),
  });

  return Response.json(body, {
    status: DEADLINE_EXCEEDED_STATUS,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(RETRY_AFTER_SECONDS),
    },
  });
}

export async function withRequestContext(
  request: Readonly<{ signal: AbortSignal }>,
  budgetMs: number,
  handle: (context: RequestContext) => Promise<Response>,
): Promise<Response> {
  const context = createRequestContext({ budgetMs, signal: request.signal });

  try {
    return await handle(context);
  } catch (error) {
    if (isRequestCancellationError(error)) {
      return requestCancelledResponse(error.reason);
    }
    throw error;
  } finally {
    context.dispose();
  }
}
