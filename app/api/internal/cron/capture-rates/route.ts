import { getRateCaptureResponse } from "@/lib/scheduled/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Authenticated, bounded capture of reviewed SEP-38 indicative rates.
 *
 * Scheduled independently of reputation evaluation and never invoked by a
 * public or dashboard request. It reads no public read model and returns a
 * bounded, no-store summary of what it actually observed.
 */
export async function GET(request: Request): Promise<Response> {
  return getRateCaptureResponse(request);
}
