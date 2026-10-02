import { getAnchorsApiResult } from "@/lib/api/anchors";
import { EVIDENCE_API_HEADERS } from "@/lib/api/cachePolicy";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getAnchorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: EVIDENCE_API_HEADERS,
  });
}
