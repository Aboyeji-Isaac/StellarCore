import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { getReputationApiResult } from "@/lib/api/reputation";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    const result = await getReputationApiResult();
    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "reputation.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to load reputation."),
      {},
      request,
    );
  }
}
