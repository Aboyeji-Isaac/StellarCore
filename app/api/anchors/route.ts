import { getAnchorsApiResult } from "@/lib/api/anchors";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/anchors",
  async function GET(): Promise<Response> {
    const result = await getAnchorsApiResult();

    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
