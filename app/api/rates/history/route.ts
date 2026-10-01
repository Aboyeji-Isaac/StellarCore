import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { publicApiJsonResponse } from "@/lib/api/http";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const evaluatedAt = new Date();
  const url = new URL(request.url);
  const corridor = url.searchParams.get("corridor");
  const days = url.searchParams.get("days");
  const result = await getRateHistoryApiResult(corridor, days, {
    now: () => evaluatedAt,
  });

  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
