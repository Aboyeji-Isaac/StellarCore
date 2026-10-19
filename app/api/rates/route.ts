import { getRatesApiResult } from "@/lib/api/rates";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const evaluatedAt = new Date();
  const searchParams = new URL(request.url).searchParams;
  const corridorValues = searchParams.getAll("corridor");
  const hasUnsupportedParameter = [...searchParams.keys()]
    .some((key) => key !== "corridor");
  if (corridorValues.length > 1 || hasUnsupportedParameter) {
    return Response.json({
      error: {
        code: "invalid_query",
        message: "The query parameters are invalid.",
      },
    }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const corridor = corridorValues[0] ?? null;
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
