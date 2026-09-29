import { getReputationApiResult } from "@/lib/api/reputation";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/reputation",
  async function GET(): Promise<Response> {
    const result = await getReputationApiResult();
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
