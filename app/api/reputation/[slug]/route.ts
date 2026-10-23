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

  if (request.signal?.aborted) {
    return new Response(null, {
      status: 499,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { slug } = await context.params;
  let result;
  try {
    result = await getAnchorReputationApiResult(slug, { signal: request.signal });
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
