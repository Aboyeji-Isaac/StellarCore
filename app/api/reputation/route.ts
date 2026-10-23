import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { getReputationApiResult } from "@/lib/api/reputation";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  if (request.signal?.aborted) {
    return new Response(null, {
      status: 499,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let result;
  try {
    result = await getReputationApiResult({ signal: request.signal });
  } catch (error) {
    if (request.signal?.aborted) {
      return new Response(null, {
        status: 499,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }

  if (request.signal?.aborted) {
    return new Response(null, {
      status: 499,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
