import { PUBLIC_API_REQUEST_BUDGETS_MS } from "@/constants/apiRequestBudgets";
import { getAnchorsApiResult } from "@/lib/api/anchors";
import { withRequestContext } from "@/lib/api/requestContext";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withRequestContext(
    request,
    PUBLIC_API_REQUEST_BUDGETS_MS.anchorList,
    async (context) => {
      const result = await getAnchorsApiResult({ context });

      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    },
  );
}
