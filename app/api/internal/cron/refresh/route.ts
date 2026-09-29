import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRouteTelemetry(
  "/api/internal/cron/refresh",
  async function GET(request: Request): Promise<Response> {
    return getScheduledRefreshResponse(request);
  },
);
