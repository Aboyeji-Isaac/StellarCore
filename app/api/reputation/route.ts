import { getReputationApiResult } from "@/lib/api/reputation";
import { publicApiHeaders } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getReputationApiResult();
  return Response.json(result.body, {
    status: result.status,
    headers: publicApiHeaders({ "Cache-Control": "no-store" }),
  });
}
