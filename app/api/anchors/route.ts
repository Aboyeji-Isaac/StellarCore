import { getAnchorsApiResult } from "@/lib/api/anchors";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rateLimit = await getRateLimiter().check(request, Date.now());
  if (!rateLimit.allowed) return rateLimit.response;

  const result = await getAnchorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
