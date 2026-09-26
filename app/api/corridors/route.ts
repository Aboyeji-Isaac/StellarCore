import { getCorridorsApiResult } from "@/lib/api/corridors";
import { publicApiHeaders } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getCorridorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: publicApiHeaders({ "Cache-Control": "no-store" }),
  });
}
