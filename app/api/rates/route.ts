import { getRatesApiResult, type RatesApiDependencies } from "@/lib/api/rates";
import { publicApiJsonResponse, readQueryParameter } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  dependencies: RatesApiDependencies = {},
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  const evaluatedAt = dependencies.now?.() ?? new Date();
  const corridor = readQueryParameter(new URL(request.url).searchParams, "corridor");
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
    ...dependencies,
  });

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}

