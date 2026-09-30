import { getAnchorsApiResult } from "@/lib/api/anchors";
import { publicApiJsonResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getAnchorsApiResult();

  return publicApiJsonResponse(result);
}
