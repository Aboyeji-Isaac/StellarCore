import { getRatesApiResult } from "@/lib/api/rates";
import { publicApiJsonResponse, respondUnlessRequestAborted } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return respondUnlessRequestAborted(request, async () => {
    const decision = await getRateLimiter().check(request, Date.now());
    if (!decision.allowed) return decision.response;

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
      signal: request.signal,
    });

    return publicApiJsonResponse(
      result,
      staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
    );
  });
}
