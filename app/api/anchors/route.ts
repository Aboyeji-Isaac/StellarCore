import { getAnchorsApiResult } from "@/lib/api/anchors";
import { publicApiHeaders } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getAnchorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: publicApiHeaders({ "Cache-Control": "no-store" }),
  });
}
