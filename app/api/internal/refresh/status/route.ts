import { getRefreshWatchdogResponse } from "@/lib/scheduled/watchdogHttp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return getRefreshWatchdogResponse(request);
}
