import { getRatesApiResult } from "@/lib/api/rates";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  const evaluatedAt = new Date();
  const corridor = new URL(request.url).searchParams.get("corridor");
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
  });

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
