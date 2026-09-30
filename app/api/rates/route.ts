import { getRatesApiResult } from "@/lib/api/rates";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const corridor = url.searchParams.get("corridor");
  const limit = url.searchParams.get("limit")
    ? parseInt(url.searchParams.get("limit")!, 10)
    : null;
  const after = url.searchParams.get("after");

  const evaluatedAt = new Date();
  const result = await getRatesApiResult(corridor, limit, after, {
    now: () => evaluatedAt,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
