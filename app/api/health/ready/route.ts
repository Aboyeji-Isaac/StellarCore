import { getReadinessResponse } from "@/lib/health/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return getReadinessResponse();
}