import { getScheduledRefreshResponse } from "@/lib/scheduled/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Authenticated reputation-evaluation job.
 *
 * This is the slower schedule. It evaluates persisted evidence only: it does
 * not capture rates, does not call SEP-38, and does not create observations or
 * outcomes to cover a missed capture run.
 */
export async function GET(request: Request): Promise<Response> {
  return getScheduledRefreshResponse(request);
}
