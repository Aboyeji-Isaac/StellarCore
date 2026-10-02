import { PUBLIC_API_REQUEST_BUDGETS_MS } from "@/constants/apiRequestBudgets";
import { getCorridorApiResult } from "@/lib/api/corridors";
import { withRequestContext } from "@/lib/api/requestContext";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  routeContext: Readonly<{ params: Promise<Readonly<{ slug: string }>> }>,
): Promise<Response> {
  return withRequestContext(
    request,
    PUBLIC_API_REQUEST_BUDGETS_MS.corridorDetail,
    async (context) => {
      const { slug } = await routeContext.params;
      const result = await getCorridorApiResult(slug, { context });

      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    },
  );
}
