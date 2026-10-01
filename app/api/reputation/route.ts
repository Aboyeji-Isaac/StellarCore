import { getReputationApiResult } from "@/lib/api/reputation";
import { publicApiJsonResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return publicApiJsonResponse(await getReputationApiResult());
}
