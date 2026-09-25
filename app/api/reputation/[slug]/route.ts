import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { getRateLimiter } from "@/lib/api/rateLimiter";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const rateLimit = await getRateLimiter().check(request, Date.now());
  if (!rateLimit.allowed) return rateLimit.response;

  const { slug } = await context.params;
  const result = await getAnchorReputationApiResult(slug);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
