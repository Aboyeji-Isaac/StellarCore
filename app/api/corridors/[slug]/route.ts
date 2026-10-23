import { getCorridorApiResult } from "@/lib/api/corridors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { publicApiErrorResult } from "@/lib/api/errors";
import { safeDecodePathSegment } from "@/lib/api/paths";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ slug: string }> }>,
): Promise<Response> {
  const decision = await getRateLimiter().check(request, Date.now());
  if (!decision.allowed) return decision.response;

  const { slug } = await context.params;
  const decoded = safeDecodePathSegment(slug);
  if (!decoded.ok) {
    return publicApiJsonResponse(
      publicApiErrorResult("invalid_corridor_slug", "A valid corridor slug is required."),
    );
  }

  return publicApiJsonResponse(await getCorridorApiResult(decoded.value));
}
