import { getRatesApiResult } from "@/lib/api/rates";
import { publicApiJsonResponse } from "@/lib/api/http";
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
  const searchParams = new URL(request.url).searchParams;
  const corridorValues = searchParams.getAll("corridor");
  const hasUnsupportedParameter = [...searchParams.keys()]
    .some((key) => key !== "corridor");
  if (corridorValues.length > 1 || hasUnsupportedParameter) {
    return Response.json({
      error: {
        code: "invalid_query",
        message: "The query parameters are invalid.",
      },
    }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const corridor = corridorValues[0] ?? null;
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
  });

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
