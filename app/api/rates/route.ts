import { getRatesApiResult, type RatesApiDependencies } from "@/lib/api/rates";
import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  dependencies?: RatesApiDependencies,
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    const evaluatedAt = new Date();
    const corridor = new URL(request.url).searchParams.get("corridor");
    const result = await getRatesApiResult(corridor, {
      now: () => evaluatedAt,
      ...dependencies,
    });

    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "rates.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to read rates."),
      {},
      request,
    );
  }
}
