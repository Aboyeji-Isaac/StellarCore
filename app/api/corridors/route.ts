import { getCorridorsApiResult } from "@/lib/api/corridors";
import { readPaginationQuery } from "@/lib/api/pagination";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const result = await getCorridorsApiResult(
    {},
    readPaginationQuery(new URL(request.url).searchParams),
  );

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
