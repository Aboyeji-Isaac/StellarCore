import { getAnchorApiResult } from "@/lib/api/anchors";
import { withRouteTelemetry } from "@/lib/telemetry/route";

export const dynamic = "force-dynamic";

export const GET = withRouteTelemetry(
  "/api/anchors/[slug]",
  async function GET(
    _request: Request,
    context: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
  ): Promise<Response> {
    const { slug } = await context.params;
    const result = await getAnchorApiResult(slug);

    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  },
);
