import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { getRateLimiter } from "@/lib/api/rateLimiter";
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

  const evaluatedAt = new Date();
  const url = new URL(request.url);
  const corridor = url.searchParams.get("corridor");
  const days = url.searchParams.get("days");
  let result;
  try {
    result = await getRateHistoryApiResult(corridor, days, {
      now: () => evaluatedAt,
      signal: request.signal,
    });
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
