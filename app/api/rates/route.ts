import { getRatesApiResult } from "@/lib/api/rates";
import { publicApiHeaders } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const evaluatedAt = new Date();
  const corridor = new URL(request.url).searchParams.get("corridor");
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: publicApiHeaders({ "Cache-Control": "no-store" }),
  });
}
