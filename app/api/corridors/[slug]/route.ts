import { getCorridorApiResult } from "@/lib/api/corridors";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/corridors/[slug]",
  async function GET(
    _request: Request,
    context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
  ): Promise<Response> {
    const { slug } = await context.params;
    const result = await getCorridorApiResult(slug);

    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
