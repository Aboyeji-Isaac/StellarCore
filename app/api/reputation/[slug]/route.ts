import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { publicApiJsonResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const { slug } = await context.params;
  const result = await getAnchorReputationApiResult(slug);
  return publicApiJsonResponse(result);
}
