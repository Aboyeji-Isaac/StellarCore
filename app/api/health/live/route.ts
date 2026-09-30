import { getLivenessResponse } from "@/lib/health/http";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return getLivenessResponse();
}