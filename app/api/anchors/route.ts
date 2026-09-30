import { getAnchorsApiResult } from "@/lib/api/anchors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit")
    ? parseInt(url.searchParams.get("limit")!, 10)
    : null;
  const after = url.searchParams.get("after");

  const result = await getAnchorsApiResult(limit, after);

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
