import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";

import {
  publicApiJsonResponse,
  readQueryParameter,
  respondUnlessRequestAborted,
} from "@/lib/api/http";
import {
  getRateHistoryApiResult,
  type RateHistoryApiDependencies,
} from "@/lib/api/rateHistory";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    const evaluatedAt = new Date();
    const url = new URL(request.url);
    const corridor = url.searchParams.get("corridor");
    const days = url.searchParams.get("days");
    const result = await getRateHistoryApiResult(corridor, days, {
      now: () => evaluatedAt,
    });

    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "rates.history.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to read rate history."),
      {},
      request,
    );
  }
  return respondUnlessRequestAborted(request, async () => {
    const decision = await getRateLimiter().check(request, Date.now());

    if (!decision.allowed) {
      return decision.response;
    }

    const evaluatedAt = new Date();
    const url = new URL(request.url);

    const corridor = readQueryParameter(url.searchParams, "corridor");
    const days = readQueryParameter(url.searchParams, "days");

    const dependencies: RateHistoryApiDependencies = {
      now: () => evaluatedAt,
      signal: request.signal,
    };

    const result = await getRateHistoryApiResult(
      corridor,
      days,
      dependencies,
    );

    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders(
        "degraded" in result ? result.degraded : undefined,
      ),
    );
  });
}
