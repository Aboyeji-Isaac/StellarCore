import { getCorridorsApiResult } from "@/lib/api/corridors";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/corridors",
  async function GET(): Promise<Response> {
    const result = await getCorridorsApiResult();

    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
