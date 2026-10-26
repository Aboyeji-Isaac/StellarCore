import { getAnchorApiResult } from "@/lib/api/anchors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { publicApiErrorResult } from "@/lib/api/errors";
import { safeDecodePathSegment } from "@/lib/api/paths";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/requestId";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ slug: string }> }>,
): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;

  const { slug } = await context.params;
  const decoded = safeDecodePathSegment(slug);
  if (!decoded.ok) {
    return publicApiJsonResponse(
      publicApiErrorResult(
        "invalid_anchor_slug",
        "A valid anchor slug is required.",
        requestId,
      ),
      { [REQUEST_ID_HEADER]: requestId },
    );
  }

  return publicApiJsonResponse(
    await getAnchorApiResult(decoded.value, { requestId }),
    { [REQUEST_ID_HEADER]: requestId },
  );
}
