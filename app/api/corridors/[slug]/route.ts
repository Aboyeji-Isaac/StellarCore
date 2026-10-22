import { getCorridorApiResult } from "@/lib/api/corridors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { requestIdHeaders, resolveRequestId } from "@/lib/api/requestId";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ slug: string }> }>,
): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;

  const { slug } = await context.params;
  return publicApiJsonResponse(
    await getCorridorApiResult(slug, { requestId }),
    requestIdHeaders(requestId),
  );
}
