import { getRatesApiResult } from "@/lib/api/rates";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const evaluatedAt = new Date();
  const corridor = new URL(request.url).searchParams.get("corridor");
  const result = await getRatesApiResult(corridor, {
    now: () => evaluatedAt,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
