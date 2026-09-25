import { getCorridorsApiResult } from "@/lib/api/corridors";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rateLimit = await getRateLimiter().check(request, Date.now());
  if (!rateLimit.allowed) return rateLimit.response;

  const result = await getCorridorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}

