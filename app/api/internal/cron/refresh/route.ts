import { getScheduledRefreshResponse } from "@/lib/scheduled/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return getScheduledRefreshResponse(request);
}
