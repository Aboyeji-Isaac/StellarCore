import { getAnchorApiResult } from "@/lib/api/anchors";
import { publicApiHeaders } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const { slug } = await context.params;
  const result = await getAnchorApiResult(slug);

  return Response.json(result.body, {
    status: result.status,
    headers: publicApiHeaders({ "Cache-Control": "no-store" }),
  });
}
