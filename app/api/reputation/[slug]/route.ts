import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  const { slug } = await context.params;
  const result = await getAnchorReputationApiResult(slug);
  return Response.json(result.body, {
    status: result.status,
    headers: staleEvidenceHeaders("degraded" in result ? result.degraded : undefined),
  });
}
