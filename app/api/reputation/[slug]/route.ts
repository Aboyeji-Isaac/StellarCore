import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    const { slug } = await context.params;
    const result = await getAnchorReputationApiResult(slug);
    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "reputation.detail.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to load reputation."),
      {},
      request,
    );
  }
}
