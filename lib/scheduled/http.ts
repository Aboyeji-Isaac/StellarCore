import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { runReviewedRateCapture } from "@/lib/scheduled/captureRates";
import { runReputationEvaluation } from "@/lib/scheduled/refresh";
import { readCaptureCadenceHealth } from "@/lib/scheduled/cadenceHealthReadModel";
import type { CaptureCadenceHealth } from "@/types/scheduling";
import type { ScheduledReputationEvaluationResult } from "@/types/scheduled";

export type AuthorizedRunHttpDependencies<T extends object> = Readonly<{
  cronSecret?: string | undefined;
  run?: () => Promise<T>;
}>;

/**
 * Reputation evaluation boundary. Authenticated, bounded, and independent of
 * rate capture: invoking it never captures a rate.
 */
export function getScheduledRefreshResponse(
  request: Request,
  dependencies: AuthorizedRunHttpDependencies<ScheduledReputationEvaluationResult> = {},
): Promise<Response> {
  return respond(
    request,
    dependencies,
    runReputationEvaluation,
    "Unable to run scheduled reputation evaluation.",
  );
}

/**
 * Reviewed rate-capture boundary. Authenticated, bounded, and independent of
 * reputation evaluation: invoking it never evaluates or writes a score.
 */
export function getRateCaptureResponse(
  request: Request,
  dependencies: AuthorizedRunHttpDependencies<Awaited<ReturnType<typeof runReviewedRateCapture>>> = {},
): Promise<Response> {
  return respond(
    request,
    dependencies,
    runReviewedRateCapture,
    "Unable to run reviewed rate capture.",
  );
}

/**
 * Operator-facing cadence health. It reports whether StellarCore's capture
 * process ran on schedule; it is not anchor reachability, quote availability,
 * transfer success, or rate evidence.
 */
export function getCaptureCadenceHealthResponse(
  request: Request,
  dependencies: AuthorizedRunHttpDependencies<CaptureCadenceHealth> = {},
): Promise<Response> {
  return respond(
    request,
    dependencies,
    readCaptureCadenceHealth,
    "Unable to read capture cadence health.",
  );
}

async function respond<T extends object>(
  request: Request,
  dependencies: AuthorizedRunHttpDependencies<T>,
  fallback: () => Promise<T>,
  failureMessage: string,
): Promise<Response> {
  if (!hasValidCronAuthorization(
    request.headers.get("authorization"),
    dependencies.cronSecret,
  )) {
    return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  }

  try {
    const run = dependencies.run ?? fallback;
    return json(await run(), 200);
  } catch {
    return json({ error: { code: "internal_error", message: failureMessage } }, 500);
  }
}

function json(body: object, status: 200 | 401 | 500): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
