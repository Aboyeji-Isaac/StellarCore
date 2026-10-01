import { getCorridorsApiResult } from "@/lib/api/corridors";
import { publicApiJsonResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return publicApiJsonResponse(await getCorridorsApiResult());
}
