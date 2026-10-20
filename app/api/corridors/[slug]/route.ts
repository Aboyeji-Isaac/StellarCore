import { getCorridorApiResult, type CorridorApiDependencies } from "@/lib/api/corridors";
import { consolePublicApiErrorReporter, publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ slug: string }> }>,
  dependencies?: CorridorApiDependencies,
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  try {
    const { slug } = await context.params;
    return publicApiJsonResponse(
      await getCorridorApiResult(slug, dependencies),
      {},
      request,
    );
  } catch (error) {
    consolePublicApiErrorReporter(error, {
      operation: "corridors.detail.route",
      code: "internal_error",
    });
    return publicApiJsonResponse(
      publicApiErrorResult("internal_error", "Unable to load corridors."),
      {},
      request,
    );
  }
}
