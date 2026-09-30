import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import { applyPermanentFailureSuppression } from "@/lib/scheduled/suppression";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const response = await getScheduledRefreshResponse(request);
  return applyPermanentFailureSuppression(request, response);
}
