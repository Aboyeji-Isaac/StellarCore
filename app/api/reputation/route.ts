import { EVIDENCE_API_HEADERS } from "@/lib/api/cachePolicy";
import { getReputationApiResult } from "@/lib/api/reputation";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getReputationApiResult();
  return Response.json(result.body, {
    status: result.status,
    headers: EVIDENCE_API_HEADERS,
  });
}
