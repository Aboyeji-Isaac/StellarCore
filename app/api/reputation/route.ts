import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { getReputationApiResult } from "@/lib/api/reputation";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/requestId";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;

  const result = await getReputationApiResult({ requestId });
  return publicApiJsonResponse(result, {
    ...staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
    [REQUEST_ID_HEADER]: requestId,
  });
}
