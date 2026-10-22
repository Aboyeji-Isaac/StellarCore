import { getCorridorsApiResult } from "@/lib/api/corridors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { readPaginationQuery } from "@/lib/api/pagination";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { requestIdHeaders, resolveRequestId } from "@/lib/api/requestId";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;
  return publicApiJsonResponse(
    await getCorridorsApiResult(
      { requestId },
      readPaginationQuery(new URL(request.url).searchParams),
    ),
    requestIdHeaders(requestId),
  );
}
