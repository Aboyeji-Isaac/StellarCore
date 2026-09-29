import { after } from "next/server";

import {
  addCounter,
  elapsedSeconds,
  flushTelemetry,
  instruments,
  markSpanError,
  recordHistogram,
  tracer,
} from "@/lib/telemetry/core";
import {
  ATTR,
  errorTypeOf,
  sanitizeAttributes,
  type RouteTemplate,
} from "@/lib/telemetry/semantics";

/**
 * Wraps an API route handler with a span and request metrics labelled only by
 * the route template, method, status code, and a coarse result class. The
 * handler's response, including its safe error envelope, is returned
 * unchanged; telemetry never adds request-time network or database work.
 */
export function withRouteTelemetry<Args extends unknown[]>(
  route: RouteTemplate,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const base = { [ATTR.httpMethod]: "GET", [ATTR.httpRoute]: route };
    const startedAt = performance.now();
    let status = 500;
    addCounter(instruments().httpActive, 1, base);

    try {
      return await tracer().startActiveSpan(`GET ${route}`, {
        attributes: sanitizeAttributes(base),
      }, async (span) => {
        try {
          const response = await handler(...args);
          status = response.status;
          span.setAttribute(ATTR.httpStatusCode, status);
          if (status >= 500) markSpanError(span, String(status));
          return response;
        } catch (error) {
          markSpanError(span, errorTypeOf(error));
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      addCounter(instruments().httpActive, -1, base);
      recordHistogram(instruments().httpDuration, elapsedSeconds(startedAt), {
        ...base,
        [ATTR.httpStatusCode]: status,
        [ATTR.result]: resultClass(status),
      });
      scheduleFlushAfterResponse();
    }
  };
}

function resultClass(status: number): string {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "ok";
}

/**
 * Serverless functions may freeze once the response is sent, dropping
 * batched telemetry. On such hosts the bounded flush runs after the response
 * via Next.js `after()`, so it never delays or fails the request.
 */
function scheduleFlushAfterResponse(): void {
  if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    after(() => flushTelemetry());
  } catch {
    // Outside a request scope (tests, scripts) there is nothing to extend.
  }
}
