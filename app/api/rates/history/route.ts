import { publicApiJsonResponse, readQueryParameter } from "@/lib/api/http";
import {
  getRateHistoryApiResult,
  type RateHistoryApiDependencies,
} from "@/lib/api/rateHistory";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  dependencies: RateHistoryApiDependencies = {},
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  const evaluatedAt = dependencies.now?.() ?? new Date();
  const url = new URL(request.url);
  const corridor = readQueryParameter(url.searchParams, "corridor");
  const days = readQueryParameter(url.searchParams, "days");
  const result = await getRateHistoryApiResult(corridor, days, {
    now: () => evaluatedAt,
    ...dependencies,
  });

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}

