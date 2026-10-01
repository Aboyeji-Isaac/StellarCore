import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { publicApiJsonResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: Readonly<{ params: Promise<{ slug: string }> }>,
): Promise<Response> {
  const { slug } = await context.params;
  return publicApiJsonResponse(await getAnchorReputationApiResult(slug));
}
