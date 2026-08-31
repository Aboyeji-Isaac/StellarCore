import { getCorridorsApiResult } from "@/lib/api/corridors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getCorridorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}

