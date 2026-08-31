import { getAnchorsApiResult } from "@/lib/api/anchors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getAnchorsApiResult();

  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
