import { getCorridorsApiResult } from "@/lib/api/corridors";
import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { readPaginationQuery } from "@/lib/api/pagination";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    return publicApiJsonResponse(
      await getCorridorsApiResult(
        {},
        readPaginationQuery(new URL(request.url).searchParams),
      ),
      {},
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "corridors.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to load corridors."),
      {},
      request,
    );
  }
}
