import { getReputationApiResult } from "@/lib/api/reputation";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getReputationApiResult();
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
