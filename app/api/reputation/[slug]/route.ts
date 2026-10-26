import { publicApiJsonResponse } from "@/lib/api/http";
import { publicApiErrorResult } from "@/lib/api/errors";
import { safeDecodePathSegment } from "@/lib/api/paths";
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

  const { slug } = await context.params;
  const decoded = safeDecodePathSegment(slug);
  if (!decoded.ok) {
    return publicApiJsonResponse(
      publicApiErrorResult("invalid_anchor_slug", "A valid anchor slug is required."),
    );
  }

  const result = await getAnchorReputationApiResult(decoded.value);
  return publicApiJsonResponse(
    result,
    staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  );
}
