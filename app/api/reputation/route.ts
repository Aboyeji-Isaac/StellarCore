import { publicApiJsonResponse } from "@/lib/api/http";
import { getReputationApiResult } from "@/lib/api/reputation";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getReputationApiResult();
  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
