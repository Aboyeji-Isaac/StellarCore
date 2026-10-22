import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { requestIdHeaders, resolveRequestId } from "@/lib/api/requestId";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;

  const { slug } = await context.params;
  const result = await getAnchorReputationApiResult(slug, { requestId });
  return publicApiJsonResponse(result, {
    ...staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
    ...requestIdHeaders(requestId),
  });
}
