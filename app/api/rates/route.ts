import { getRatesApiResult } from "@/lib/api/rates";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/rates",
  async function GET(request: Request): Promise<Response> {
    const evaluatedAt = new Date();
    const corridor = new URL(request.url).searchParams.get("corridor");
    const result = await getRatesApiResult(corridor, {
      now: () => evaluatedAt,
    });

    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
