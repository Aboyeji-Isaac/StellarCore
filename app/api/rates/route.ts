import { PUBLIC_API_REQUEST_BUDGETS_MS } from "@/constants/apiRequestBudgets";
import { getRatesApiResult } from "@/lib/api/rates";
import { withRequestContext } from "@/lib/api/requestContext";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const evaluatedAt = new Date();
  const corridor = new URL(request.url).searchParams.get("corridor");

  return withRequestContext(
    request,
    PUBLIC_API_REQUEST_BUDGETS_MS.rateObservations,
    async (context) => {
      const result = await getRatesApiResult(corridor, {
        now: () => evaluatedAt,
        context,
      });

      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    },
  );
}
