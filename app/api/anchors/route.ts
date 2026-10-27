import { getAnchorsApiResult } from "@/lib/api/anchors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { readPaginationQuery } from "@/lib/api/pagination";
import { getRateLimiter } from "@/lib/api/rateLimiter";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/requestId";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request);
  const decision = await getRateLimiter().check(request, Date.now(), requestId);
  if (!decision.allowed) return decision.response;
  return publicApiJsonResponse(
    await getAnchorsApiResult(
      { requestId },
      readPaginationQuery(new URL(request.url).searchParams),
    ),
    { [REQUEST_ID_HEADER]: requestId },
  );
}
